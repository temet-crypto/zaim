# ZAIM

A dead simple Zcash wallet. Sign in with your seed, hold shielded ZEC, send and
receive private payments, message over shielded memos, swap in and out of ZEC
across chains, and leave ZEC drops at physical coordinates with GeoVault. Lives
at [zaim.info](https://zaim.info).

## What it is, honestly

ZAIM is a **custodial web app**, by design, so that signing in is as simple as
pasting a seed phrase. Being honest about the trust model matters more than a
buzzword, so here is the whole picture:

- **Your keys, while you are signed in, are held by the server.** Your seed
  travels to the server when you open the wallet, and the keys live in memory
  for the length of your session.
- **At rest, wallets are sealed.** When you sign out (or after 30 minutes idle),
  your wallet files are encrypted into a blob with a key derived from your own
  seed, and the plaintext is deleted. The server cannot open a sealed wallet.
- **Payments can carry an app fee.** When the operator sets `FEE_ADDRESS` and
  `FEE_BPS`, that percentage is added on top of each payment and the screen
  says so before you press send. Unset, there is no fee. The recipient always
  gets the full amount either way.
- **Your seed is standard.** It is an ordinary Zcash seed phrase. You can paste
  it into [Zashi](https://electriccoin.co/zashi/), Ywallet, or any Zcash wallet
  and walk away with your funds at any time, with no permission from us. ZAIM is
  custodial *hosting* of self sovereign wallets, not an account ledger.

ZAIM is **not decentralized**. It runs on one server operated by us. What it
runs *on* is open and decentralized, and every piece is checkable below.

## What it runs on

| Layer | What | Link |
|---|---|---|
| Network | Zcash mainnet | https://z.cash |
| Wallet engine | zingolib (zingo-cli) | https://github.com/zingolabs/zingolib |
| Light server | zec.rocks lightwalletd | https://zec.rocks |
| Cross chain swaps | NEAR Intents | https://near-intents.org |

## Stack

- **Frontend:** React + Vite, one brutalist design system shared with the rest
  of Temet Crypto.
- **Backend:** FastAPI wrapping `zingo-cli`, one wallet directory per seed
  fingerprint, AES-GCM sealed storage.
- **Serving:** host nginx terminates TLS and proxies `/api` to the container.

## Security notes

- The seed phrase is the only credential. There are no usernames, passwords, or
  account records.
- Contacts and any local notes live in the browser, not on the server.
- Admin endpoints are OFF unless `ZAIM_ADMIN_PASSWORD` is set in the
  environment. There is no built in default.
- The page makes no third party requests. Fonts are served from this origin
  and the ZEC price is fetched by the server, so opening ZAIM tells nobody
  else you did.
- Messages embed a `Reply-to:` line in the shielded memo so conversations can
  thread. Incoming memos without one show as sender unknown, because a
  shielded transaction genuinely does not say who sent it.
- GeoVault escrow is custodial and the location check trusts device GPS.
  Treat vaults as small value drops, not a settlement layer.
- `nginx/zaim-security.conf` has the security headers the live site runs with.

## License

[MIT](./LICENSE)
