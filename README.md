# ZAIM

A dead simple Zcash wallet. Sign in with your seed, hold shielded ZEC, send and
receive private payments, swap in and out of ZEC across chains. Lives at
[zaim.info](https://zaim.info).

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
- Set `ZAIM_ADMIN_PASSWORD` in the environment before deploying; the built in
  default is for local development only and prints a startup warning.

## License

[MIT](./LICENSE)
