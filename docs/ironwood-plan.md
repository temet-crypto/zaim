# Ironwood (NU6.3 / ZIP 318) plan

Written 2026-09-26. Model: Zodl, the ECC-lineage wallet, because it is what
most ZEC users will have seen and it has already shipped the flow.

## Why this is not optional

NU6.3 activated on mainnet 2026-07-28 at height 3,428,143. From then the
**Turnstile** disables ordinary payments into Orchard and limits Orchard spends
to spends-plus-change. Orchard funds stay spendable, but every ZAIM balance
lives in Orchard, and the only way forward for it is Ironwood.

The deployed zingo-cli predates Ironwood. It logs `Unknown transaction format`
/ `invalid consensus branch id 0x37a5165b` on Ironwood transactions and skips
them on mainnet (halts on testnet). "Synced to tip" does not mean working: the
wallet is blind to incoming Ironwood funds. Whether its sends still confirm on
mainnet since 2026-07-28 is unverified; container logs do not survive a
restart.

## Engine

`zingolib_v6.0.0` (released 2026-09-08) is the first stable release carrying
Ironwood (`Feat/ironwood stable backport`, #2473): four pools, Ironwood in the
summaries, `migrate` / `drain` commands. Built at
`~/Desktop/Projects/Code/ZAIM/zingolib-v6` with one ZAIM patch, the opt-in null
OVK (`ZINGO_OVK_DISCARD=1`). The seed-from-env fix (`ZINGO_SEED`) is upstream
now, which closes the seed-in-argv item: set the env var, drop `--seed`.

Behavior changes that touch `api/main.py`:

- **Offline by default** (ADR 0025). A session goes online only with a stored
  Connectivity Consent, a `connectivity-consent` file beside the wallet holding
  `standing-online`. Every ZAIM wallet dir needs it, or nothing syncs.
- **Mixnet by default** (ADR 0026). `default = ["nym"]`; a build without it can
  sync but cannot transmit. Keep the default and ship `nym-proxy` beside the
  binary, as the AI relay already does. First online op pays a multi-minute
  Nym bootstrap, so the API needs a long-lived session, not one process per call.
- **CLI output**: stdout is the result, stderr is narration (ADR 0031). Run
  `scripts/zingo-compat.sh` old vs new before anything else; the CLI was
  reworked (#2283, #2294), so expect shape diffs.

## Transport: Nym, not Tor

Zodl uses Tor (Arti). ZAIM's engine is zingolib, whose supported transport is
the Nym mixnet; clearnet transmission is compiled out of normal builds and
marked "never for use". Either way the outcome Zodl is after holds: the
indexer and the Migration Transmission Endpoint never see the host's IP, and
migration parts are not correlatable with sync. Existing Tor egress
(`ZAIM_TOR_SOCKS`) stays for anything that is not zingo.

## What the user sees (Zodl's flow)

1. **Prompt** when an Orchard balance exists. Dismissable; comes back next
   sign in.
2. **Two choices**:
   - *Private (recommended)*: note splitting (self-sends, nothing leaves the
     wallet), then Parts: fixed Denominations, one per transaction, sent in
     Batches spread across Buckets. Small balances finish in hours; large ones
     are deliberately spread longer.
   - *Immediate*: one Drain, all at once, amounts visible on chain.
3. **Plan review before confirming**: number of transfers, total fees (each is a
   normal network fee), estimated finish, and **Stranded** value: anything too
   small to move (under the Sweep Minimum, roughly < 0.01 ZEC) stays in
   Orchard and is shown, never silently dropped.
4. **Progress**: "Transfer 2 of 5", remaining Orchard balance, percent.
5. **Address does not change.** Ironwood uses the existing Orchard receiver.

## The key constraint: signing per Batch

A Batch is signed and transmitted in one visit while its Bucket is open. With
view-key sign in, the server holds no spending key between visits, so ZAIM
matches Zodl on iOS: the open tab holds the seed in memory (`holdSeed`) and
posts it once per Batch when the window opens; the UI says to keep the tab open,
and a closed tab resumes on next sign in. Never store the seed server side to
make this unattended; that undoes view-key sign in.

## Order of work

1. Build v6 + nym-proxy for linux/amd64. Compat gate against prod on testnet.
2. Adapt `main.py`: consent file, `ZINGO_SEED` instead of `--seed`, long-lived
   session, new output shapes, Ironwood in balances and tx pool labels.
3. Testnet: receive Ironwood, send, Drain, private migration end to end.
4. UI: prompt, plan review, progress, pool labels.
5. Mainnet with Dusty's own wallet first; only then the other wallets.
6. GeoVault escrow and treasury wallets migrate too (server-held keys, so they
   can run the private path unattended).
