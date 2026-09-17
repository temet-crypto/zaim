// Golden vectors for browser-side key derivation.
//
// These UFVKs were produced by zingolib itself — `zingo-cli export_ufvk` on
// 2026-09-17 — from the mnemonic below. The wasm module must reproduce them
// byte for byte, because the server opens whatever wallet the key we send it
// describes. A derivation that drifts by one character does not error: it
// silently opens a different, empty wallet, which reads to a user as lost
// funds. Hence golden vectors rather than "it returns something uview-shaped".
//
// The mnemonic is the standard all-zero BIP-39 test vector. It is public,
// holds nothing, and must never be used for anything real.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init, { ufvk_from_mnemonic, ufvk_fingerprint } from "../keys/zaim_keys.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon art";

const GOLDEN = {
  mainnet:
    "uview1wj07tp4y3rwzjplg68c3lum2avq4v3j0w0mf0urdlxzthnfr26q8ssz9hvylspj638tuh2r233gaxm2qh27gj6m9q25prk7gt8xwqzmwxm580tg0f5llvr7d6h4y6jc2t7zl7lz9ge60ta6226jyysgk8xpu2wqxesrw4q2mydrhj5dea5l9scl0p3l4ayqgfej54wex5aa2ylq89nyqg94l4lh6dawuc2e3s8v7737zn7p5fl96hhpjqg4jucnp2r2jjqxev3z7lp3k9ulfpl2gw0lng8vfe8hj8afggqzdwxgfaq6dy82guvh34kv4q5ay7gq6n0ujg7exu0mgznpr4wf0agjdhnd4k6af5md3f3msqedw364vx3lyd3hwekvrulywa4c0ja4ze2fxtcm0vrz0278g9n37y0jg6dx847g3peyq9lwmm04ac3tt4sldnrcfc5ew3k0aqgycnryfvv44zxzng485ks27wky2ulfy9q8hu97l",
  testnet:
    "uviewtest1w4wqdd4qw09p5hwll0u5wgl9m359nzn0z5hevyllf9ymg7a2ep7ndk5rhh4gut0gaanep78eylutxdua5unlpcpj8gvh9tjwf7r20de8074g7g6ywvawjuhuxc0hlsxezvn64cdsr49pcyzncjx5q084fcnk9qwa2hj5ae3dplstlg9yv950hgs9jjfnxvtcvu79mdrq66ajh62t5zrvp8tqkqsgh8r4xa6dr2v0mdruac46qk4hlddm58h3khmrrn8awwdm20vfxsr9n6a94vkdf3dzyfpdul558zgxg80kkgth4ghzudd7nx5gvry49sxs78l9xft0lme0llmc5pkh0a4dv4ju6xv4a2y7xh6ekrnehnyrhwcfnpsqw4qwwm3q6c8r02fnqxt9adqwuj5hyzedt9ms9sk0j35ku7j6sm6z0m2x4cesch6nhe9ln44wpw8e7nnyak0up92d6mm6dwdx4r60pyaq7k8vj0r2neqxtqmsgcrd",
};

beforeAll(async () => {
  // The web build fetches its own .wasm by URL, which Node cannot do over
  // file://, so hand it the bytes directly.
  await init(readFileSync(new URL("../keys/zaim_keys_bg.wasm", import.meta.url)));
});

describe("ufvk_from_mnemonic", () => {
  it.each(["mainnet", "testnet"])("matches zingolib on %s", (net) => {
    expect(ufvk_from_mnemonic(MNEMONIC, net)).toBe(GOLDEN[net]);
  });

  it("tags the network in the key itself", () => {
    expect(ufvk_from_mnemonic(MNEMONIC, "mainnet").startsWith("uview1")).toBe(true);
    expect(ufvk_from_mnemonic(MNEMONIC, "testnet").startsWith("uviewtest1")).toBe(true);
  });

  it("accepts the short network aliases", () => {
    expect(ufvk_from_mnemonic(MNEMONIC, "main")).toBe(GOLDEN.mainnet);
    expect(ufvk_from_mnemonic(MNEMONIC, "test")).toBe(GOLDEN.testnet);
  });

  it("is insensitive to case and stray whitespace", () => {
    expect(ufvk_from_mnemonic("  " + MNEMONIC.toUpperCase() + "\n", "mainnet")).toBe(GOLDEN.mainnet);
  });

  it("rejects an unknown network rather than guessing", () => {
    expect(() => ufvk_from_mnemonic(MNEMONIC, "regtest")).toThrow(/unknown network/);
  });

  it("rejects a phrase whose checksum fails", () => {
    // Last word changed: valid words, wrong checksum. Accepting this would
    // strand the user on a wallet that is not theirs.
    const typo = MNEMONIC.replace(/art$/, "abandon");
    expect(() => ufvk_from_mnemonic(typo, "mainnet")).toThrow(/checksum/);
  });

  it.each([11, 13, 23])("rejects a %i word phrase", (n) => {
    const words = MNEMONIC.split(" ").slice(0, n).join(" ");
    expect(() => ufvk_from_mnemonic(words, "mainnet")).toThrow(/12, 15, 18, 21 or 24/);
  });

  it("never returns anything that could spend", () => {
    // A spending key would encode as uspend/secret-extended; a leak here is
    // the one bug in this module that loses money.
    for (const net of ["mainnet", "testnet"]) {
      const k = ufvk_from_mnemonic(MNEMONIC, net);
      expect(k).toMatch(/^uview(test)?1/);
      expect(k).not.toMatch(/secret|spend|^uspend/i);
    }
  });
});

describe("ufvk_fingerprint", () => {
  it("agrees with the server", () => {
    // sha256("zaim-ufvk-v1:" + ufvk)[:8] hex, same as api/main.py. If these
    // drift, every sign in opens a different wallet directory.
    expect(ufvk_fingerprint(GOLDEN.mainnet)).toBe("3a253af8f006757d");
  });

  it("is 16 hex characters", () => {
    expect(ufvk_fingerprint(GOLDEN.testnet)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates the networks", () => {
    expect(ufvk_fingerprint(GOLDEN.mainnet)).not.toBe(ufvk_fingerprint(GOLDEN.testnet));
  });

  it("ignores surrounding whitespace", () => {
    expect(ufvk_fingerprint(" " + GOLDEN.mainnet + " ")).toBe(ufvk_fingerprint(GOLDEN.mainnet));
  });
});
