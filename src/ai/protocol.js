// ZAI1 — the AI tab's memo protocol. Versioned, binary, and deliberately
// foreign to messenger memos: neither side parses the other's traffic.
//
// Two deviations from the original brief, both documented here because the
// relay must mirror them exactly:
//   1. REQ carries a 2-byte chunk field (i, n) right after req_id, so
//      multi-memo questions need no second format.
//   2. The request payload is SEALED TO THE RELAY's X25519 key in the
//      browser. This is what keeps question plaintext away from the ZAIM
//      app server — the server forwards opaque bytes it cannot read. The
//      first payload byte is a codec id so compression can upgrade from
//      deflate-raw (native, dictionary-less) to zstd+dictionary in Phase 3
//      without a version bump.
//
// Layouts (memo is at most 512 bytes):
//   REQ   "ZAI1" 0x01 req_id(16) chunk_i(1) chunk_n(1) conv_hash(32)
//         reply_addr_len(1) reply_addr eph_pubkey(32) sealed_payload
//   REP   "ZAI1" 0x02 req_id(16) chunk_i(1) chunk_n(1) sealed_payload
//   ERR   "ZAI1" 0x03 …same shape as REP
//   TOPUP "ZAI1" 0x04 …same shape as REP
//   DUMMY "ZAI1" 0x05 random bytes (discarded unread)
//
// Sealing (both directions): sender ephemeral X25519 -> shared secret ->
// HKDF-SHA256 -> AES-256-GCM. Wire form: eph_pk(32) nonce(12) ct||tag.

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

// A Zcash memo is 512 raw bytes, but zingo-cli accepts memos as UTF-8 text,
// so ZAI1 binary travels base64-encoded (the messenger's zaim-sync memos set
// this precedent). ceil(n/3)*4 <= 512 caps the binary payload at 384 bytes.
export const MEMO_MAX = 384;
export const MAGIC = new TextEncoder().encode("ZAI1");
export const TYPE = { REQ: 0x01, REP: 0x02, ERR: 0x03, TOPUP: 0x04, DUMMY: 0x05 };
export const CODEC = { RAW: 0x00, DEFLATE: 0x01, ZSTD_DICT_V1: 0x02 };

const te = new TextEncoder();
const td = new TextDecoder();

export class ZaiError extends Error {}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// ── compression ──────────────────────────────────────────────────────────────
// deflate-raw via the browser-native CompressionStream: zero dependencies and
// available in every runtime ZAIM targets (Chrome/Safari/Node 20). Codec 0x02
// (zstd + shared dictionary) lands with the relay in Phase 3.

async function pump(stream, bytes) {
  const w = stream.writable.getWriter();
  w.write(bytes); w.close();
  const chunks = [];
  const r = stream.readable.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  return concat(...chunks);
}

export async function compress(text) {
  const raw = te.encode(text);
  const deflated = await pump(new CompressionStream("deflate-raw"), raw);
  // Short questions often inflate under deflate; ship whichever is smaller.
  return deflated.length < raw.length
    ? concat(Uint8Array.of(CODEC.DEFLATE), deflated)
    : concat(Uint8Array.of(CODEC.RAW), raw);
}

export async function decompress(payload) {
  if (payload.length === 0) throw new ZaiError("empty payload");
  const body = payload.slice(1);
  switch (payload[0]) {
    case CODEC.RAW: return td.decode(body);
    case CODEC.DEFLATE: return td.decode(await pump(new DecompressionStream("deflate-raw"), body));
    default: throw new ZaiError(`unknown codec ${payload[0]}`);
  }
}

// ── sealing ──────────────────────────────────────────────────────────────────

async function aesKey(shared, ephPk, recipientPk, usage) {
  const keyBytes = hkdf(sha256, shared, concat(ephPk, recipientPk), te.encode("zai1-seal-v1"), 32);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [usage]);
}

/** Encrypt to a recipient's X25519 public key. Anyone can seal; only the holder opens. */
export async function seal(plain, recipientPk) {
  const ephSk = x25519.utils.randomSecretKey();
  const ephPk = x25519.getPublicKey(ephSk);
  const shared = x25519.getSharedSecret(ephSk, recipientPk);
  const key = await aesKey(shared, ephPk, recipientPk, "encrypt");
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  ephSk.fill(0);
  return concat(ephPk, nonce, ct);
}

export async function open(box, recipientSk) {
  if (box.length < 32 + 12 + 16) throw new ZaiError("sealed box too short");
  const ephPk = box.slice(0, 32);
  const nonce = box.slice(32, 44);
  const ct = box.slice(44);
  const shared = x25519.getSharedSecret(recipientSk, ephPk);
  const recipientPk = x25519.getPublicKey(recipientSk);
  const key = await aesKey(shared, ephPk, recipientPk, "decrypt");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  } catch {
    throw new ZaiError("sealed box failed to open");
  }
}

export const newEphemeralKeypair = () => {
  const sk = x25519.utils.randomSecretKey();
  return { sk, pk: x25519.getPublicKey(sk) };
};

// ── request build / parse ────────────────────────────────────────────────────

function reqHeader(reqId, i, n, convHash, replyAddr, ephPk) {
  const addr = te.encode(replyAddr);
  if (addr.length > 255) throw new ZaiError("reply address too long");
  return concat(MAGIC, Uint8Array.of(TYPE.REQ), reqId, Uint8Array.of(i, n), convHash, Uint8Array.of(addr.length), addr, ephPk);
}

/**
 * Build the full set of request memos for one question. Every chunk repeats
 * the header so the relay can start assembling from any memo it sees first.
 * Returns { reqId, ephSk, memos: Uint8Array[] } — the caller keeps ephSk
 * locally (never sent) and wipes it after the answer decrypts.
 */
export async function buildRequest({ question, convHash, replyAddr, relayPk }) {
  const reqId = randomBytes(16);
  const { sk: ephSk, pk: ephPk } = newEphemeralKeypair();
  const sealed = await seal(await compress(question), relayPk);

  const headLen = reqHeader(reqId, 0, 1, convHash, replyAddr, ephPk).length;
  const room = MEMO_MAX - headLen;
  if (room < 32) throw new ZaiError("reply address leaves no room for payload");
  const n = Math.ceil(sealed.length / room);
  if (n > 255) throw new ZaiError("question too large");
  const memos = [];
  for (let i = 0; i < n; i++) {
    memos.push(concat(reqHeader(reqId, i, n, convHash, replyAddr, ephPk), sealed.slice(i * room, (i + 1) * room)));
  }
  return { reqId, ephSk, memos };
}

export function parseRequestMemo(memo) {
  if (memo.length < 4 + 1 + 16 + 2 + 32 + 1) throw new ZaiError("memo too short");
  if (!MAGIC.every((b, i) => memo[i] === b)) throw new ZaiError("not a ZAI1 memo");
  if (memo[4] !== TYPE.REQ) throw new ZaiError("not a request memo");
  let o = 5;
  const reqId = memo.slice(o, o + 16); o += 16;
  const chunkI = memo[o++], chunkN = memo[o++];
  const convHash = memo.slice(o, o + 32); o += 32;
  const addrLen = memo[o++];
  const replyAddr = td.decode(memo.slice(o, o + addrLen)); o += addrLen;
  const ephPk = memo.slice(o, o + 32); o += 32;
  return { reqId, chunkI, chunkN, convHash, replyAddr, ephPk, payload: memo.slice(o) };
}

// ── reply build / parse ──────────────────────────────────────────────────────

export function buildReplyMemos(type, reqId, sealedPayload, room = MEMO_MAX - (4 + 1 + 16 + 2)) {
  const n = Math.ceil(sealedPayload.length / room) || 1;
  if (n > 255) throw new ZaiError("reply too large");
  const memos = [];
  for (let i = 0; i < n; i++) {
    memos.push(concat(MAGIC, Uint8Array.of(type), reqId, Uint8Array.of(i, n), sealedPayload.slice(i * room, (i + 1) * room)));
  }
  return memos;
}

export function parseReplyMemo(memo) {
  if (memo.length < 4 + 1 + 16 + 2) throw new ZaiError("memo too short");
  if (!MAGIC.every((b, i) => memo[i] === b)) throw new ZaiError("not a ZAI1 memo");
  const type = memo[4];
  if (type === TYPE.REQ) throw new ZaiError("request memo on the reply path");
  return { type, reqId: memo.slice(5, 21), chunkI: memo[21], chunkN: memo[22], payload: memo.slice(23) };
}

/** Reassemble reply chunks (any order), open with the request's ephemeral key, decompress. */
export async function assembleReply(chunks, ephSk) {
  if (chunks.length === 0) return null; // nothing arrived yet: still waiting
  const n = chunks[0].chunkN;
  const seen = new Map();
  for (const c of chunks) {
    if (c.chunkN !== n) throw new ZaiError("inconsistent chunk count");
    seen.set(c.chunkI, c.payload);
  }
  if (seen.size !== n) return null; // still waiting on chunks
  const parts = [];
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) return null;
    parts.push(seen.get(i));
  }
  return decompress(await open(concat(...parts), ephSk));
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
