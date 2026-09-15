# ZAIM AI Tab + Fees — Phase 1: Repo Audit and Plan

Audited 2026-09-16 against the live repo and the running production system.
Everything below was verified by inspection or by probing the deployed
zingo-cli, not assumed from the brief.

## 1. What the repo actually is

| Brief assumes | ZAIM reality |
|---|---|
| Client-side wallet core with key derivation | **Server-side wallet.** FastAPI (`api/main.py`, ~2,100 lines) drives a zingo-cli subprocess per wallet dir. The browser is a thin client; the seed is POSTed to the server at sign-in. |
| Compact-block scanner in the app | zingo-cli **is** the compact-block scanner with trial decryption — but it runs server-side. The frontend scans nothing. |
| ZIP-32 multi-account derivation | zingo-cli 0.1.1 exposes **one account (0) per wallet dir**. No `--account` anywhere. |
| Tor/Nym transport | Tor exists as of the Tier-1 pass: `zaim-tor` container, published `.onion`, optional `ZAIM_TOR_SOCKS` egress for zingo (verified working). **No Nym anywhere; out of scope.** |
| Memo handling | Server-composed. `quicksend '[{address,amount,memo},…]'` supports **multi-output with per-output memos** (verified against the deployed binary) — chunked requests in one tx are possible. |
| Design system | `src/styles/maxpain.js` tokens; bottom nav currently `home / messages / geo / settings` (App.jsx:764) — a 5th AI tab slots in cleanly. |
| Fee machinery | **Already exists.** `FEE_ADDRESS`/`FEE_BPS` append an atomic second output on payment sends (main.py:868). Part 2 is this pattern, flat-fee, applied to `/api/message/send`. |
| Price feed | `_fetch_zec_price()` (CoinGecko, cached) already server-side. |
| Tests | **The repo has no test infrastructure at all.** The brief's test matrix requires adding it (vitest for the protocol lib, pytest for the relay). |

Other verified facts: default UAs are **orchard-only** (`new_address [o|z]`,
no transparent receivers — probe showed `has_orchard: true, has_sapling:
false`), which satisfies "Orchard only" natively. `@scure/bip39` and `idb`
are already frontend dependencies — client-side seed math and an encrypted
local conversation store need no new architecture.

## 2. The honest architectural conflict

The brief's hardest requirement — *"unlinkable … including by ZAIM's own
servers"* — **cannot be met by this codebase**, because the app server
unseals user wallets, composes every transaction, and today sees every memo
plaintext. No amount of relay separation fixes that; the linkage happens at
composition time, before anything touches the chain.

What this architecture CAN honestly deliver:

- **Content privacy from the app server.** The browser encrypts the question
  to the relay's X25519 key and hands the app server opaque bytes; replies
  are encrypted to a browser-held ephemeral key. The app server relays
  ciphertext it cannot read. This is real and buildable now.
- **Sender anonymity from the relay and AI provider.** The relay sees only a
  shielded transaction; with the app server and relay on separate
  infrastructure (brief already requires this), the relay cannot name the
  user.
- **Chain observers learn nothing** — unchanged, shielded memos.

What remains visible to the app server: *that* an account used the AI tab,
when, and how much it paid — metadata, not content. The truthful label is:

> "Anonymous to the relay and the AI provider. The ZAIM server can see that
> your account used AI, not what you asked. Self-host to remove that too."

Full unlinkability is the client-side-wallet rebuild (the ZAIM Tier-3 item,
WebZjs) — months, and this brief should not silently depend on it.
**Decision 1** below.

## 3. Adaptations forced by verified reality

1. **AI account = separate wallet dir, derived client-side.** No ZIP-32
   account 1 exists in zingo-cli. Instead the browser derives
   `ai_seed = HKDF(main-seed entropy, "zaim-ai-v1")` → new 24-word mnemonic
   (bip39 dep already present) and opens it exactly like a `zw_` wallet, as
   `zai_<fingerprint>`. Recoverable from the main seed alone, distinct keys
   on-chain, never reuses messenger addresses. Sealing/idle logic is reused
   unchanged.
2. **OVK-null is not possible through zingo-cli.** The CLI exposes no OVK
   control on sends — neither for relay replies nor the treasury output.
   MVP ships without it (relay wallet key hygiene + deletion schedule as
   mitigation); the real fix is the relay moving to librustzcash or a small
   zingolib patch. Scheduled as Phase 4b with its own decision.
3. **"Client trial-decrypts full blocks" re-scoped.** Scanning is zingo's
   job server-side; it already syncs compact blocks rather than fetching
   single transactions. The brief's rule becomes: *the app server never
   fetches individual transactions from lightwalletd on behalf of an AI
   request, and all zingo egress can route through Tor* (`ZAIM_TOR_SOCKS`,
   already built).
4. **Fixed action counts** are composable today via dummy self-outputs in
   the `quicksend` array (messenger default 4, replies default 8).
5. **Fast mode (Phase 7)** has no library support in the stack; RSA blind
   signatures via Python `cryptography` primitives on the relay, tokens
   redeemed over the existing `.onion`. Flagged, last.

## 4. File-level plan

**Frontend (`zaim-repo/src/`)**
- `ai/protocol.js` — ZAI1 encode/decode, chunk/reassemble, X25519 seal/open
  (`@noble/curves`), zstd + shared dictionary (`fzstd` or zstd-wasm).
  Golden vectors in `shared/zai1-vectors.json`; the relay must pass the
  identical vectors.
- `ai/derive.js` — HKDF main→AI mnemonic (client-only; the AI seed never
  exists server-side outside its sealed wallet).
- `ai/store.js` — idb conversation store, encrypted with a key derived
  client-side; `conv_secret` lives here; "New identity" rotates it.
- `AiTab.jsx` — thread with `sending → confirmed → thinking → answered`,
  block countdown, balance strip + Top up, mode toggle (Fast greyed until
  Phase 7), fee-breakdown sheet, the honest label, MAXPAIN tokens.
- `App.jsx` — 5th nav tab.

**App server (`api/main.py`, thin additions, no messenger changes)**
- `/api/ai/open|balance|topup` — open the `zai_` wallet from the
  client-derived seed; internal shielded transfer main→AI.
- `/api/ai/send` — accepts relay address + amount + opaque memo chunks;
  builds one multi-output quicksend. Server never sees plaintext.
- `/api/ai/inbox` — new-note ciphertext chunks from the AI wallet, by
  `req_id`.
- `/api/ai/quote` — USD components → ZEC at spot with the 10% buffer;
  components (`reply_network_cost`, `inference_cost`, `zaim_fee`) from env.

**Relay (new repo `zaim-ai-relay`, own droplet, shares nothing)**
- `wallet.py` (zingo wrapper — pattern reused, code not shared),
  `protocol.py` (ZAI1 mirror), `payments.py` (tolerance check, TOPUP/drop),
  `moderation.py`, `inference.py` (provider behind an interface),
  `batcher.py` (10-block schedule, pad to 8 actions, decoy rate, continued
  answers, treasury sweep), `config.py` (every economic number), `main.py`
  (poll loop, in-flight-only state, plaintext wiped after queue).
- `tests/` — pytest: vectors, payment tolerance, padding, batching schedule.

**Part 2 (messenger fee, one function touched)**
- `/api/message/send`: behind `MESSENGER_FEE_ENABLED` (default **off**),
  flat USD-quoted `MSG_FEE` to `TREASURY_ADDRESS` as an added output, pad to
  4 actions, fee shown in the existing send confirmation. Scaffold-only env
  stubs: `HOSTED_INFRA_FEE`, `SUPPORT_TIP`, `PREMIUM_FEATURES` (all off).

## 5. Phases and estimates

| Phase | Scope | Estimate |
|---|---|---|
| 1 | This audit | done |
| 2 | AI wallet derivation + tab UI, mocked relay | 2–3 days |
| 3 | Relay MVP on testnet (no padding) | 3–4 days + droplet |
| 4 | Padding, batching, decoys, inner crypto e2e; **4b: OVK decision** | ~1 week |
| 5 | Pricing, breakdown UI, treasury sweeps | 2 days |
| 6 | Messenger fee behind flag | 1 day |
| 7 | Fast mode (blind tokens + onion) | ~1 week |
| 8 | Mainnet checklist + legal/provider items | — |

## 6. Decisions needed before Phase 2

1. **Accept the honest privacy model** (app server sees AI-usage metadata,
   never content) with the label above — or gate the feature on the Tier-3
   client wallet? Recommendation: accept and ship; revisit at Tier 3.
2. **Relay droplet** (~$6–12/mo, separate from everything). Approve?
3. **OVK-null gap**: defer to Phase 4b (librustzcash relay or zingo patch)?
4. **AI provider + API key** — yours to procure; it lives in the relay
   box's env, never in the repo or chat.
5. **Treasury address** — owner-created, owner-held seed.
