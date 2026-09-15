# Running your own ZAIM

The public instance at zaimwallet.com receives your seed phrase. That is not a
bug you can configure away, it is what the architecture is: the wallet engine
runs on the server, not in your browser. If you are not comfortable with that,
the answer is to be the server.

This is the whole procedure. It takes about twenty minutes, most of which is
Rust compiling.

## What you need

- A Linux box with 2 GB of RAM and 10 GB free. A $12 droplet is enough.
- Docker with the compose plugin.
- A domain, if you want TLS. Skip it and you get an onion address instead, which
  is arguably the better answer anyway.

## 1. Get the wallet engine

`zingo-cli` is the wallet. It is deliberately **not** in this repository: it is a
76 MB binary and vendoring one into a wallet project is how supply chain attacks
happen. Build it yourself so you know what you are running.

```bash
git clone https://github.com/zingolabs/zingolib
cd zingolib
cargo build --release --bin zingo-cli
cp target/release/zingo-cli /path/to/zaim/zingo-cli
```

The public instance runs **Zingo CLI 0.1.1**. Check yours matches:

```bash
./zingo-cli --version
```

If it does not, nothing here is guaranteed. The API parses this binary's output,
and that output is not a stable interface.

## 2. Configure

```bash
git clone https://github.com/temet-crypto/zaim
cd zaim
cp zingo-cli .                      # from step 1
mkdir -p wallets && chmod 700 wallets
```

Everything is environment variables on the `zaim-api` service in
`docker-compose.do.yml`:

| Variable | Default | What it does |
|---|---|---|
| `LIGHTWALLETD_SERVER` | `https://zec.rocks:443` | Indexer this instance defaults to |
| `ZAIM_SERVERS` | the four zec.rocks endpoints | Comma separated allowlist users may pick from |
| `ZAIM_ALLOW_ANY_SERVER` | unset | Set to `1` to let any https indexer be used. Do this only on an instance you alone use: it turns the box into an outbound proxy |
| `ZAIM_TOR_SOCKS` | unset | Set to `zaim-tor:9050` to push all indexer traffic through Tor |
| `ZAIM_ADMIN_PASSWORD` | unset | Unset means the admin endpoints do not exist. Leave it unset |
| `ZAIM_IDLE_SEAL_MIN` | `30` | Minutes before an idle wallet is sealed |
| `ZAIM_SIGNIN_MAX_PER_IP` | `8` | Sign in attempts per IP per window |
| `ZAIM_MAX_RESTORES` | `2` | Concurrent chain restores. Raise only with cores to spare |
| `FEE_ADDRESS` / `FEE_BPS` | empty / `0` | House fee on sends. Empty means no fee |

## 3. Start it

```bash
docker compose -f docker-compose.do.yml up -d
```

That builds the API image, starts nginx, and starts Tor. First boot takes a few
minutes because of the pip install.

Your onion address appears once Tor has bootstrapped:

```bash
docker exec zaim-tor cat /var/lib/tor/zaim/hostname
```

Put that hostname into the `server_name` of the onion block in
`nginx/zaim-api.conf`, and into the `Onion-Location` header in the https block,
then `docker exec zaim-web nginx -s reload`.

> Note the `server_names_hash_bucket_size 128;` at the top of that file. A v3
> onion hostname is 62 characters and nginx refuses to load the config without
> it.

## 4. TLS, if you are using a domain

Point an A record at the box first. Certbot cannot run before DNS resolves.

```bash
docker run --rm -v /etc/letsencrypt:/etc/letsencrypt \
  -v /path/to/zaim/dist:/webroot certbot/certbot certonly \
  --webroot -w /webroot -d your.domain --agree-tos -m you@example.com
docker compose -f docker-compose.do.yml up -d --force-recreate --no-deps zaim-web
```

## 5. Back up the things that exist nowhere else

Losing any of these loses money. None of them are in git.

- `wallets/` — every user wallet. The `.sealed` files need their owner's seed to
  open, but the plaintext directories of currently active wallets do not.
- `wallets/_vault_key` — 32 bytes that decrypt GeoVault messages at rest.
- `wallets/_escrow/` — holds real funds for open vaults. Read its seed once,
  write it on paper, and never run this again:
  ```bash
  docker exec -it zaim-api /app/zingo-cli \
      --offline --data-dir /app/wallets/_escrow recovery_info
  ```
- The `zaim_tor-data` volume — your onion private key. Lose it and your address
  changes, and there is no way to prove the new one is you.

## Two things worth knowing before you trust this

**The seed passes through a command line.** `zingo-cli` takes a seed only as
`--seed <phrase>`, so during a first restore the phrase is visible in that
process's argv for as long as the sync runs. Anything that can read
`/proc/<pid>/cmdline` in the API container, or run `docker top`, can see it.
Fixing this properly means patching zingolib to accept the seed on stdin and
rebuilding.

**Nginx `add_header` does not merge across levels.** A `location` block that
declares even one `add_header` inherits none from the server block. The
`/assets/` block repeats the full security header set for exactly this reason.
The same rule bit this project once already, with a `types { }` block that
silently replaced the entire MIME map and served the whole site as
`application/octet-stream` for three weeks.
