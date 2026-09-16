// Encrypted local conversation store. Lives in IndexedDB, encrypted with a
// key derived from the AI seed (see derive.js), so wiping the browser loses
// nothing the seed can't recover the FUNDS for — but conversations are
// device-local by design and never synced anywhere.

import { openDB } from "idb";

const DB = "zaim-ai";
const STORE = "conversations";
const PENDING = "pending";

async function db() {
  return openDB(DB, 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) d.createObjectStore(STORE, { keyPath: "id" });
      if (oldVersion < 2) d.createObjectStore(PENDING, { keyPath: "id" });
    },
  });
}

async function aesKey(storeKeyBytes, usage) {
  return crypto.subtle.importKey("raw", storeKeyBytes, "AES-GCM", false, [usage]);
}

async function sealJson(obj, keyBytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyBytes, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce); out.set(ct, 12);
  return out.buffer;
}

async function openJson(buf, keyBytes) {
  const b = new Uint8Array(buf);
  const key = await aesKey(keyBytes, "decrypt");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── pending requests ─────────────────────────────────────────────────────────
// The ephemeral secret key is the ONLY thing that can open an answer. Held in
// a closure alone, closing the tab or refreshing the page before the reply
// lands makes a PAID answer undecryptable forever: the ciphertext sits on
// chain and the key is gone. So it is persisted, encrypted at rest with the
// store key, from the moment the question is sent until the answer opens.

export async function savePending(reqIdHex, ephSk, meta, keyBytes) {
  const d = await db();
  await d.put(PENDING, {
    id: reqIdHex,
    blob: await sealJson({ ephSk: Array.from(ephSk), ...meta, ts: Date.now() }, keyBytes),
  });
}

export async function listPending(keyBytes) {
  const d = await db();
  const out = [];
  for (const r of await d.getAll(PENDING)) {
    try {
      const v = await openJson(r.blob, keyBytes);
      out.push({ ...v, id: r.id, ephSk: Uint8Array.from(v.ephSk) });
    } catch { /* wrong key or corrupt */ }
  }
  return out;
}

/** Call only after the answer has decrypted, or the answer becomes unreadable. */
export async function clearPending(reqIdHex) {
  const d = await db();
  await d.delete(PENDING, reqIdHex);
}

/** conversation shape: { id, title, convSecret(hex), messages: [{role, text, status, reqId, ts}] } */
export async function saveConversation(conv, keyBytes) {
  const d = await db();
  await d.put(STORE, { id: conv.id, blob: await sealJson(conv, keyBytes) });
}

export async function listConversations(keyBytes) {
  const d = await db();
  const rows = await d.getAll(STORE);
  const out = [];
  for (const r of rows) {
    try { out.push(await openJson(r.blob, keyBytes)); } catch { /* wrong key or corrupt: skip */ }
  }
  return out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

export async function deleteConversation(id) {
  const d = await db();
  await d.delete(STORE, id);
}
