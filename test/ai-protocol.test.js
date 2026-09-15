import { describe, expect, it } from "vitest";
import {
  MEMO_MAX, TYPE, ZaiError,
  assembleReply, buildReplyMemos, buildRequest, compress, decompress,
  newEphemeralKeypair, open, parseReplyMemo, parseRequestMemo, seal,
} from "../src/ai/protocol.js";
import { convHash, deriveAiMnemonic, deriveStoreKey, newConvSecret, ZERO_CONV } from "../src/ai/derive.js";

// A real orchard-only testnet UA shape (length is what matters to the format).
const REPLY_ADDR = "utest15mrha2xrx4yful3ealngu0h9educ0085qesumaz7c3llspdc3c2mhdcrx5a8lfvx3ny0tlcz9ts9uex8mqg2gguehmeru4d5cunccyfu";
const MAIN_SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("sealing", () => {
  it("round-trips and only the recipient can open", async () => {
    const relay = newEphemeralKeypair();
    const other = newEphemeralKeypair();
    const box = await seal(new TextEncoder().encode("secret"), relay.pk);
    expect(new TextDecoder().decode(await open(box, relay.sk))).toBe("secret");
    await expect(open(box, other.sk)).rejects.toThrow(ZaiError);
  });
  it("tampering breaks the seal", async () => {
    const relay = newEphemeralKeypair();
    const box = await seal(new TextEncoder().encode("x"), relay.pk);
    box[box.length - 1] ^= 0x01;
    await expect(open(box, relay.sk)).rejects.toThrow(ZaiError);
  });
});

describe("compression", () => {
  it("round-trips long english and picks raw for tiny strings", async () => {
    const long = "the quick brown privacy fox ".repeat(40);
    expect(await decompress(await compress(long))).toBe(long);
    const tiny = await compress("hi");
    expect(tiny[0]).toBe(0x00); // RAW: deflate would inflate two bytes
    expect(await decompress(tiny)).toBe("hi");
  });
});

describe("request build/parse", () => {
  it("single-memo question round-trips through the relay's parser", async () => {
    const relay = newEphemeralKeypair();
    const secret = newConvSecret();
    const { reqId, ephSk, memos } = await buildRequest({
      question: "What is a shielded transaction?",
      convHash: convHash(secret), replyAddr: REPLY_ADDR, relayPk: relay.pk,
    });
    expect(memos).toHaveLength(1);
    expect(memos[0].length).toBeLessThanOrEqual(MEMO_MAX);
    const p = parseRequestMemo(memos[0]);
    expect(p.chunkN).toBe(1);
    expect(p.replyAddr).toBe(REPLY_ADDR);
    expect([...p.reqId]).toEqual([...reqId]);
    // Relay-side open + decompress recovers the exact question.
    const question = await decompress(await open(p.payload, relay.sk));
    expect(question).toBe("What is a shielded transaction?");
    ephSk.fill(0);
  });

  it("a long question chunks across memos, every chunk self-describing", async () => {
    const relay = newEphemeralKeypair();
    const question = Array.from(crypto.getRandomValues(new Uint8Array(600)), (b) => b.toString(16).padStart(2, "0")).join(""); // 1200 chars of hex: incompressible
    const { memos } = await buildRequest({ question, convHash: ZERO_CONV, replyAddr: REPLY_ADDR, relayPk: relay.pk });
    expect(memos.length).toBeGreaterThan(1);
    const parsed = memos.map(parseRequestMemo);
    expect(new Set(parsed.map((p) => p.chunkN)).size).toBe(1);
    for (const p of parsed) expect(p.replyAddr).toBe(REPLY_ADDR); // header repeats
    // Reassemble out of order.
    const sealed = new Uint8Array(parsed.reduce((n, p) => n + p.payload.length, 0));
    let o = 0;
    for (const p of [...parsed].sort((a, b) => b.chunkI - a.chunkI).sort((a, b) => a.chunkI - b.chunkI)) {
      sealed.set(p.payload, o); o += p.payload.length;
    }
    expect(await decompress(await open(sealed, relay.sk))).toBe(question);
  });
});

describe("reply build/assemble", () => {
  it("multi-chunk reply reassembles out of order and decrypts with the ephemeral key", async () => {
    const user = newEphemeralKeypair();
    const reqId = crypto.getRandomValues(new Uint8Array(16));
    const answer = Array.from(crypto.getRandomValues(new Uint8Array(700)), (b) => b.toString(16).padStart(2, "0")).join(""); // incompressible so it must chunk
    const sealed = await seal(await compress(answer), user.pk);
    const memos = buildReplyMemos(TYPE.REP, reqId, sealed);
    expect(memos.length).toBeGreaterThan(1);
    for (const m of memos) expect(m.length).toBeLessThanOrEqual(MEMO_MAX);
    const chunks = memos.map(parseReplyMemo).reverse(); // out of order on purpose
    expect(await assembleReply(chunks, user.sk)).toBe(answer);
  });

  it("returns null while chunks are missing", async () => {
    const user = newEphemeralKeypair();
    const reqId = new Uint8Array(16);
    const sealed = await seal(await compress(Array.from(crypto.getRandomValues(new Uint8Array(600)), (b) => b.toString(16).padStart(2, "0")).join("")), user.pk);
    const memos = buildReplyMemos(TYPE.REP, reqId, sealed);
    const partial = memos.slice(1).map(parseReplyMemo);
    expect(await assembleReply(partial, user.sk)).toBeNull();
  });

  it("rejects messenger-style memos outright", () => {
    expect(() => parseReplyMemo(new TextEncoder().encode("hello old friend, long time"))).toThrow(/not a ZAI1/);
  });
});

describe("derivation", () => {
  it("AI mnemonic is deterministic, valid, and different from the main seed", () => {
    const a = deriveAiMnemonic(MAIN_SEED);
    expect(a).toBe(deriveAiMnemonic(MAIN_SEED));
    expect(a.split(" ")).toHaveLength(24);
    expect(a).not.toBe(MAIN_SEED);
  });
  it("store key is 32 bytes and stable", () => {
    const ai = deriveAiMnemonic(MAIN_SEED);
    const k = deriveStoreKey(ai);
    expect(k.length).toBe(32);
    expect([...deriveStoreKey(ai)]).toEqual([...k]);
  });
  it("conv hash commits to the secret without revealing it", () => {
    const s = newConvSecret();
    const h = convHash(s);
    expect(h.length).toBe(32);
    expect([...h]).not.toEqual([...s]);
  });
});
