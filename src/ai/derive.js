// AI account derivation — entirely client-side, which is the point.
//
// zingo-cli has no ZIP-32 multi-account support (one account per wallet dir),
// so the AI account is a SECOND SEED, derived deterministically from the main
// seed in the browser: HKDF over the mnemonic's entropy with a fixed info
// tag, back out to a 24-word mnemonic. Properties that matter:
//   - Recoverable: anyone holding the main seed can re-derive the AI seed,
//     so "back up one phrase" stays true.
//   - Unlinkable on-chain: different entropy, different keys, no shared
//     addresses with the messenger or main wallet.
//   - The derivation never happens server-side. The server only ever sees
//     the derived seed at open time, exactly as it sees the main seed —
//     that boundary is unchanged by this feature.
//
// Also here: the conversation secret and the local-store key, both HKDF'd
// from the AI entropy so "one phrase recovers everything" extends to the
// encrypted conversation archive.

import { mnemonicToEntropy, entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const te = new TextEncoder();

export function deriveAiMnemonic(mainMnemonic) {
  const entropy = mnemonicToEntropy(mainMnemonic.trim().toLowerCase(), wordlist);
  const aiEntropy = hkdf(sha256, entropy, te.encode("zaim"), te.encode("zaim-ai-v1"), 32);
  return entropyToMnemonic(aiEntropy, wordlist);
}

/** 32-byte key for the encrypted local conversation store. */
export function deriveStoreKey(aiMnemonic) {
  const entropy = mnemonicToEntropy(aiMnemonic.trim().toLowerCase(), wordlist);
  return hkdf(sha256, entropy, te.encode("zaim"), te.encode("zaim-ai-store-v1"), 32);
}

/** Fresh conversation secret; only its hash ever leaves the device. */
export function newConvSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function convHash(convSecret) {
  return sha256(convSecret);
}

export const ZERO_CONV = new Uint8Array(32); // "new conversation" sentinel on the wire
