# View-key sign in — scope

Goal: **the seed stops arriving at the server on sign in.** Today it is POSTed,
used to build a wallet, and held in memory for the session. After this, a
normal sign in sends only a Unified Full Viewing Key (UFVK) and the server is
cryptographically unable to spend.

Not a rewrite. The read side of ZAIM already works this way; it just has not
been asked to.

## What was proven, not assumed

Ran against the live testnet relay wallet on 2026-09-17. A wallet created with
`zingo-cli --viewkey <UFVK> --birthday N`:

| capability | result |
|---|---|
| sync | 3,841 blocks, 1,900 ironwood outputs, 100% scanned |
| balance | correct (82,528 zats) |
| read memos, received | yes |
| read memos, **sent** | yes (the UFVK carries the outgoing viewing key) |
| spend | **refused** — "No unified spending key found for this account. No spend capability" |

So a view-key server can do everything ZAIM's server does today except move
money. That is the whole proposition.

## The one hard part: deriving the UFVK in the browser

If the server derives the UFVK it must first see the seed, which defeats the
exercise. So derivation has to happen client side, and that is Zcash-specific
crypto: ZIP-32 Orchard/Sapling derivation plus ZIP-316 F4Jumble encoding. It is
not reachable from the bip39 library already in the bundle.

Three ways, in order of preference:

1. **A tiny wasm module.** Not WebZjs — just derivation. `zcash_keys 0.16`
   (already in zingolib's tree) does it in a few lines:
   `UnifiedSpendingKey::from_seed(...)` then `.to_unified_full_viewing_key()`.
   Exposed through `wasm-bindgen` as one function, seed in, UFVK string out.
   No proving, no sync, no network, so the artifact is small and the audit
   surface is one function. This is the recommendation.
2. **WebZjs.** Real, but last pushed April 2026, 39 stars, and **publishes
   nothing to npm** — adopting it means vendoring and building it anyway, for
   far more than we need at this stage. Revisit when the write path is on the
   table, since that is where its proving code earns its keep.
3. **Pure JS reimplementation.** Rejected: hand-rolling ZIP-32 and F4Jumble for
   a key-derivation path is how funds get lost to an encoding bug.

We already know the toolchain works — the Ironwood build proved a Rust
cross-compile pipeline, and F4Jumble is implemented and tested in
`zaim-ai-relay/tools/ua_to_sapling.py`, which is a usable reference.

## Flow

**Normal sign in (new default)**
1. Browser takes the seed, never sends it.
2. wasm derives UFVK + the AI account's UFVK.
3. POST `/api/wallet/open_view` with `{ufvk, birthday}`.
4. Server opens a view-only wallet, namespace `zv_<fingerprint of the UFVK>`.
5. Everything reads normally. The Send and Message buttons are live but route
   through the spend path below.

**Spending, interim (seed per send, never at rest)**
The server cannot sign, so a send needs spend authority for that one
transaction. Browser POSTs the seed with the send, server derives the spending
key in-process, signs, and wipes it. Honest and checkable:

> "Your seed never reaches us when you sign in or while you read. It reaches us
> for the moment you send, and is gone when the send completes."

That is a real reduction: the exposure window goes from the whole session to a
few seconds per send, and an idle or read-only session holds nothing spendable.

**Spending, endgame**
Browser-side signing, seed never transmitted. Needs shielded proving in wasm
(WebZjs, or PCZT once zingolib implements it — today PCZT appears only in their
ADRs). Separate decision, separate budget.

**Recovery**
Today the seed at sign in IS the restore mechanism. Under view-key sign in the
server has no seed to restore from, so:
- A UFVK sign in on an unknown wallet triggers a scan from the supplied
  birthday, same as now, because a UFVK is all that syncing needs.
- "Restore with spend access" stays an explicit, separately labelled action
  that does send the seed, for the case where a user has lost their device and
  wants the server to rebuild a spendable wallet.
- Sealing: the seal key is derived from the seed today. Under view-key sign in
  derive it from the UFVK instead, or the server cannot re-seal what it opened.
  **This is the subtlest part of the change and needs its own test.**

## Work

| step | scope |
|---|---|
| wasm derivation module | Rust crate + wasm-bindgen, one exported function, vendored into `src/ai/`. ~1 day incl. the cross-build. |
| `/api/wallet/open_view` | mirrors `_ensure_wallet_open` with `--viewkey`; new `zv_` namespace; seal key from UFVK. ~1 day. |
| send path | accept per-send seed, derive, sign, wipe; never log, never persist. ~1 day. |
| sealing + recovery tests | the failure mode is an unopenable wallet, so this gets real tests. ~1 day. |
| UI + honest claims | claim 01 rewritten; a visible indicator for read-only vs spend-capable session. ~half a day. |

Call it **a week**, and it is worth it: "we never receive your seed at sign in"
is a claim almost no hosted wallet can make, and it is verifiable by anyone
watching the request.

## Risks

- **Seal-key change is a migration.** Existing `zw_` wallets seal with a
  seed-derived key. View-key wallets cannot reproduce it. Run both namespaces
  side by side rather than migrating in place.
- **Birthday.** A UFVK carries no birthday. Without one the server scans from
  sapling activation, which is slow and expensive. The client must supply it,
  and store it locally after the first sync.
- **It does not fix the AI tab's threat model.** Questions are already sealed
  client side; this changes wallet custody, not what the relay sees.
- **Transparent addresses.** The UFVK covers the shielded pools. Anything
  transparent needs checking separately — ZAIM's flows are orchard-only, so this
  should be a non-issue, but verify before shipping.
