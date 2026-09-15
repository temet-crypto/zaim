// Encrypted local conversation store. Lives in IndexedDB, encrypted with a
// key derived from the AI seed (see derive.js), so wiping the browser loses
// nothing the seed can't recover the FUNDS for — but conversations are
// device-local by design and never synced anywhere.

import { openDB } from "idb";

const DB = "zaim-ai";
const STORE = "conversations";

async function db() {
  return openDB(DB, 1, {
    upgrade(d) {
      d.createObjectStore(STORE, { keyPath: "id" });
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
