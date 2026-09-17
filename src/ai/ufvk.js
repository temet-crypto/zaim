// Seed to Unified Full Viewing Key, on this device.
//
// The point of this file is what it does NOT do: it never sends the seed
// anywhere. The seed goes into wasm, a viewing key comes out, and only the
// viewing key is allowed near the network. The server can then sync, show
// balances and read memos, and is cryptographically unable to spend.
//
// The wasm is loaded lazily. It is 1.7 MB, which is a real cost, so it is
// fetched on the sign-in action rather than on first paint — most visits to
// the app never need it.

let ready = null;

async function keys() {
  if (!ready) {
    ready = (async () => {
      const m = await import("../keys/zaim_keys.js");
      await m.default();
      return m;
    })().catch(err => {
      // Do not cache a failed load; a flaky network on first try should not
      // permanently break sign in for the rest of the session.
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** Warm the module without deriving anything, so the sign-in tap feels instant. */
export function prewarm() {
  keys().catch(() => {});
}

/**
 * Derive the UFVK for a seed phrase.
 * @param {string} seed  BIP-39 mnemonic. Stays on this device.
 * @param {string} network  "mainnet" or "testnet".
 * @returns {Promise<string>} uview1… / uviewtest1…
 */
export async function ufvkFromSeed(seed, network = "mainnet") {
  const m = await keys();
  return m.ufvk_from_mnemonic(seed, network);
}

/**
 * Stable handle for a UFVK. Matches ufvk_fingerprint() in api/main.py — if the
 * two ever disagree, every sign in opens a different wallet than it left.
 */
export async function ufvkFingerprint(ufvk) {
  const m = await keys();
  return m.ufvk_fingerprint(ufvk);
}

/** True if the wasm module can run here. Older browsers get the seed path. */
export async function supported() {
  try {
    await keys();
    return true;
  } catch {
    return false;
  }
}
