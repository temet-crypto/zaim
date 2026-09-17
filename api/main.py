"""
ZAIM Backend API - FastAPI + zingo-cli (Zcash Light Client)
v0.9.0 - Engine migration: zecwallet-cli (2021, abandoned) replaced with
zingo-cli built at a pinned Ironwood-ready zingolib commit, ahead of the
NU6.3 activation on 2026-07-28. Endpoint moved to a maintained lightwalletd.
Seed-only auth and sealed wallets carry over from v0.8.0 unchanged.

The seed phrase is the only credential. Signing in restores or unlocks the
wallet; signing out seals it. At rest, wallet files live on disk ONLY as an
AES-GCM blob encrypted with a key derived from the seed itself, so the server
cannot open a sealed wallet. Plaintext wallet files exist only while a
session is active (zecwallet-cli needs a real wallet file to operate).

Notes:
  - Wallets are isolated by running the CLI with a per-wallet HOME
    (zecwallet-cli v1.8 has no --data-dir flag; it resolves ~/.zcash from $HOME).
  - Wallet identity = fingerprint of the normalized seed (sha256, 16 hex chars).
    Same seed always lands in the same wallet, from any device, no account row.
"""
import os, json, time, uuid, hashlib, hmac, secrets, asyncio, subprocess, re, socket
import tarfile, shutil, io, base64, gzip
from decimal import Decimal, ROUND_DOWN
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CLI = os.getenv("ZAIM_CLI", os.getenv("ZECWALLET_CLI", "/app/zingo-cli"))
SERVER = os.getenv("LIGHTWALLETD_SERVER", "https://zec.rocks:443")
WDIR = os.getenv("WALLET_DIR", "/app/wallets")
# zingo-cli defaults to mainnet when --chain is omitted, which is what ZAIM has
# always relied on. Named here so view-key validation can refuse a key from the
# wrong network instead of silently syncing nothing.
CHAIN_NAME = os.getenv("ZCASH_CHAIN", "mainnet")
# No default: unset means admin is OFF. A guessable shipped password on a
# wallet server is worse than no admin panel at all.
ADMIN_PASSWORD = os.getenv("ZAIM_ADMIN_PASSWORD", "")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS",
    "https://zaim.info,https://www.zaim.info,https://noscezaim.com,https://www.noscezaim.com",
).split(",") if o.strip()]
DUST = 10000
PBKDF2_ITER = 200_000

# ── Sign-in throttling ────────────────────────────────────────────────────────
# The seed endpoints are unauthenticated and expensive. A seed that matches no
# cached wallet starts a FRESH restore, which can hold a zingo-cli process for
# the full 600s timeout and write a wallet dir to disk. On a one-core box that
# makes /api/wallet/open a resource-exhaustion lever long before it is a
# brute-force target, so the concurrency cap below matters more than the counter.
SIGNIN_MAX_PER_IP = int(os.getenv("ZAIM_SIGNIN_MAX_PER_IP", "8"))
SIGNIN_WINDOW_SEC = int(os.getenv("ZAIM_SIGNIN_WINDOW_MIN", "15")) * 60
MAX_CONCURRENT_RESTORES = int(os.getenv("ZAIM_MAX_RESTORES", "2"))

signin_hits = {}   # ip -> [timestamps], trimmed to the window on each touch

def client_ip(request):
    """nginx sets both of these; fall back to the socket for direct hits."""
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.headers.get("X-Real-IP") or (request.client.host if request.client else "?")

def throttle_signin(request):
    ip = client_ip(request)
    now = time.time()
    hits = [t for t in signin_hits.get(ip, []) if now - t < SIGNIN_WINDOW_SEC]
    if len(hits) >= SIGNIN_MAX_PER_IP:
        mins = int((SIGNIN_WINDOW_SEC - (now - hits[0])) // 60) + 1
        raise HTTPException(429, detail=f"Too many sign-in attempts. Try again in {mins} minutes")
    hits.append(now)
    signin_hits[ip] = hits
    if len(signin_hits) > 5000:                     # bound the table
        for k in [k for k, v in signin_hits.items() if not v or now - v[-1] > SIGNIN_WINDOW_SEC]:
            signin_hits.pop(k, None)

# ── App fee ───────────────────────────────────────────────────────────────────
# On each payment, a cut is routed to FEE_ADDRESS as a second output of the same
# shielded transaction (atomic — one tx, one network fee). Charged on TOP of the
# amount, so the recipient always gets exactly what the user entered.
# Dormant until FEE_ADDRESS is set: leave it empty and sends behave fee-free.
FEE_ADDRESS = os.getenv("FEE_ADDRESS", "")          # house z-address that collects fees
FEE_BPS = int(os.getenv("FEE_BPS", "0"))            # fee in basis points (100 = 1.00%)
FEE_MIN_ZATS = int(os.getenv("FEE_MIN_ZATS", "0"))  # optional floor, in zatoshis

if not ADMIN_PASSWORD:
    print("[SECURITY] ZAIM_ADMIN_PASSWORD is unset — admin endpoints are disabled.", flush=True)

sessions = {}
wallet_cache = {}
SESSIONS_FILE = os.path.join(WDIR, "_sessions.json")

# ── Seed identity + sealed storage ────────────────────────────────────────────
# The seed is the only credential. A wallet is identified by a fingerprint of
# the normalized seed; its files rest on disk only as an AES-GCM blob whose key
# is derived from the seed. Keys live in memory for active sessions only and
# are never written anywhere.
IDLE_SEAL_SEC = int(os.getenv("ZAIM_IDLE_SEAL_MIN", "30")) * 60
wallet_keys = {}      # wallet_name -> 32-byte AES key (memory only)
wallet_activity = {}  # wallet_name -> last authed-request timestamp

def normalize_seed(phrase):
    words = (phrase or "").strip().lower().split()
    if len(words) < 12 or len(words) > 33 or any(not w.isalpha() for w in words):
        raise HTTPException(400, detail="That does not look like a seed phrase (12 to 24 words)")
    return " ".join(words)

def seed_fingerprint(norm_seed):
    return hashlib.sha256(("zaim-fp-v1:" + norm_seed).encode()).hexdigest()[:16]

def seed_key(norm_seed, fp):
    return hashlib.pbkdf2_hmac("sha256", norm_seed.encode(), ("zaim-seal-v1:" + fp).encode(), PBKDF2_ITER)

# ── view-key identity ─────────────────────────────────────────────────────────
# A view-key wallet has no seed here, so it cannot use seed_key. Its seal key
# comes from the UFVK instead. That is a weaker secret than a seed — the client
# hands us the UFVK on every sign in, so anyone who can replay a sign in can
# re-derive it — but the thing being protected is READ access to data the UFVK
# already grants. It buys encryption at rest against a stolen disk, and claims
# nothing more.
#
# The namespaces are deliberately separate (zw_ vs zv_): a seed wallet's seal
# key cannot be reproduced from a UFVK, so a wallet sealed one way must never
# be looked for the other way. Mixing them yields a wallet nobody can open.

# Shielded value could not exist before these heights, so there is nothing for
# a viewing key to find below them.
SAPLING_ACTIVATION = {"mainnet": 419_200, "testnet": 280_000}

def ufvk_fingerprint(ufvk):
    return hashlib.sha256(("zaim-ufvk-v1:" + ufvk.strip()).encode()).hexdigest()[:16]

def ufvk_key(ufvk, fp):
    return hashlib.pbkdf2_hmac("sha256", ufvk.strip().encode(), ("zaim-vseal-v1:" + fp).encode(), PBKDF2_ITER)

def normalize_ufvk(ufvk):
    u = (ufvk or "").strip()
    if not re.fullmatch(r"uview(test)?1[a-z0-9]{100,2000}", u):
        raise HTTPException(400, detail="That does not look like a unified full viewing key")
    want_test = u.startswith("uviewtest1")
    # A testnet key on a mainnet server syncs nothing and confuses every
    # balance the user sees, so refuse it at the door.
    if want_test != ("test" in CHAIN_NAME):
        raise HTTPException(400, detail="That viewing key is for the wrong network")
    return u

def _wallet_paths(wn):
    return os.path.join(WDIR, wn), os.path.join(WDIR, wn + ".sealed")

def seal_wallet(wn, key=None):
    """tar the wallet dir, AES-GCM encrypt it to <wn>.sealed, remove plaintext.
    Without a key (lost on restart) we can only drop plaintext if a previous
    seal exists; the next sign-in re-syncs the delta from the chain."""
    wdir, sealed = _wallet_paths(wn)
    if not os.path.isdir(wdir):
        return False
    key = key or wallet_keys.get(wn)
    if key:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as t:
            t.add(wdir, arcname=".")
        nonce = secrets.token_bytes(12)
        blob = nonce + AESGCM(key).encrypt(nonce, buf.getvalue(), b"zaim-sealed-v1")
        tmp = sealed + ".tmp"
        with open(tmp, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, sealed)
    elif not os.path.exists(sealed):
        print(f"[seal] no key and no prior seal for {wn}; leaving plaintext", flush=True)
        return False
    shutil.rmtree(wdir, ignore_errors=True)
    wallet_keys.pop(wn, None)
    wallet_activity.pop(wn, None)
    wallet_cache.pop(wn, None)
    return True

def unseal_wallet(wn, key):
    """Decrypt <wn>.sealed back into a plaintext wallet dir. False if absent."""
    wdir, sealed = _wallet_paths(wn)
    if os.path.isdir(wdir):
        return True
    if not os.path.exists(sealed):
        return False
    with open(sealed, "rb") as f:
        blob = f.read()
    try:
        data = AESGCM(key).decrypt(blob[:12], blob[12:], b"zaim-sealed-v1")
    except Exception:
        raise HTTPException(500, detail="The sealed wallet failed to open. The seed derives the key, so this should not happen")
    os.makedirs(wdir, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        t.extractall(wdir, filter="data")
    return True

def _live_wallets():
    return {s.get("wallet_name") for s in sessions.values() if s.get("wallet_name")}

async def periodic_seal():
    """Seal idle plaintext wallets so keys are not sitting on disk overnight."""
    while True:
        await asyncio.sleep(120)
        now = time.time()
        try:
            for entry in list(os.listdir(WDIR)):
                wdir = os.path.join(WDIR, entry)
                # Only seed-fingerprint wallets participate in sealing; legacy
                # password-era dirs (zaim_*) stay untouched until removed.
                if not os.path.isdir(wdir) or not entry.startswith(("zw_", "zai_", "zv_")):
                    continue
                last = wallet_activity.get(entry, 0)
                if now - last > IDLE_SEAL_SEC:
                    await aseal(entry)
        except Exception as e:
            print(f"[periodic_seal] {e}", flush=True)

def _atomic_write_json(path, data):
    """Write JSON durably: temp file + fsync + atomic rename, so a crash or
    concurrent writer can never leave a half-written _users.json."""
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def save_sessions():
    try:
        _atomic_write_json(SESSIONS_FILE, sessions)
    except Exception as e:
        print(f"[save_sessions] {e}", flush=True)

def load_sessions():
    global sessions
    try:
        if os.path.exists(SESSIONS_FILE):
            with open(SESSIONS_FILE) as f:
                sessions = json.load(f)
            cutoff = time.time() - 7 * 86400
            sessions = {k: v for k, v in sessions.items() if v.get("created", 0) > cutoff}
    except Exception:
        pass

# ── Indexer selection ─────────────────────────────────────────────────────────
# Which lightwalletd a wallet uses is a privacy decision, though not the one it
# looks like: the browser never contacts the indexer, zingo-cli does, so the
# indexer sees THIS BOX's address and every user is mixed behind it. What it can
# still build is a picture of everything ZAIM looks up and broadcasts.
#
# Reachability checked 2026-09-14. Be honest about what this list is: every entry
# is operated by zec.rocks, so choosing between them changes latency, not who can
# watch you. Pointing at your own node is the only real fix, which is what
# ZAIM_ALLOW_ANY_SERVER=1 is for when you self-host.
DEFAULT_SERVERS = [
    ("https://zec.rocks:443",    "zec.rocks, global"),
    ("https://na.zec.rocks:443", "zec.rocks, North America"),
    ("https://eu.zec.rocks:443", "zec.rocks, Europe"),
    ("https://sa.zec.rocks:443", "zec.rocks, South America"),
]
ALLOWED_SERVERS = [s.strip() for s in os.getenv(
    "ZAIM_SERVERS", ",".join(u for u, _ in DEFAULT_SERVERS)).split(",") if s.strip()]
# Off by default: an open field here turns this box into an outbound proxy for
# whatever host a caller names.
ALLOW_ANY_SERVER = os.getenv("ZAIM_ALLOW_ANY_SERVER", "") == "1"
SERVERS_FILE = os.path.join(WDIR, "_servers.json")
FEE_TOTALS_FILE = os.path.join(WDIR, "_fee_totals.json")
fee_totals = {}   # wallet_name -> lifetime zatoshis paid to treasury
wallet_servers = {}   # wallet_name -> indexer url, survives restarts

def save_wallet_servers():
    try:
        _atomic_write_json(SERVERS_FILE, wallet_servers)
    except Exception as e:
        print(f"[save_wallet_servers] {e}", flush=True)

def save_fee_totals():
    try:
        _atomic_write_json(FEE_TOTALS_FILE, fee_totals)
    except Exception as e:
        print(f"[save_fee_totals] {e}", flush=True)

def load_fee_totals():
    global fee_totals
    try:
        if os.path.exists(FEE_TOTALS_FILE):
            with open(FEE_TOTALS_FILE) as f:
                fee_totals = json.load(f)
    except Exception:
        fee_totals = {}

def load_wallet_servers():
    global wallet_servers
    try:
        if os.path.exists(SERVERS_FILE):
            with open(SERVERS_FILE) as f:
                wallet_servers = json.load(f)
    except Exception:
        wallet_servers = {}

def wallet_server(wallet_name):
    return wallet_servers.get(wallet_name) or SERVER

def validate_server(url):
    """Empty means 'use the instance default'. Anything else must be https and,
    unless this instance opted out, on the allowlist."""
    url = (url or "").strip()
    if not url:
        return SERVER
    if not url.startswith("https://"):
        raise HTTPException(400, detail="The indexer address must start with https://")
    if not ALLOW_ANY_SERVER and url not in ALLOWED_SERVERS:
        raise HTTPException(400, detail="That indexer is not on this instance's allowlist")
    return url

# ── Optional Tor egress ───────────────────────────────────────────────────────
# ZAIM_TOR_SOCKS=host:port pushes every zingo-cli call through Tor via torsocks
# (LD_PRELOAD, which works because zingo-cli is dynamically linked against
# glibc). What it buys is narrow but real: the indexer stops seeing one stable
# ZAIM address behind every query it answers. What it costs is latency on a sync
# that already runs close to its timeout on a one core box, so it stays off
# until someone has measured a restore with it on.
TOR_SOCKS = os.getenv("ZAIM_TOR_SOCKS", "").strip()
if TOR_SOCKS:
    print(f"[tor] zingo-cli egress routed through {TOR_SOCKS}", flush=True)

def cli_prefix():
    return ["torsocks"] if TOR_SOCKS else []

def wallet_env(wallet_name):
    """Per-wallet isolation: zingo-cli takes an explicit --data-dir, so every
    wallet lives in its own directory (zingo-wallet.dat and logs inside)."""
    wdir = os.path.join(WDIR, wallet_name)
    os.makedirs(wdir, exist_ok=True)
    env = dict(os.environ)
    env["HOME"] = wdir
    if TOR_SOCKS:
        host, _, port = TOR_SOCKS.partition(":")
        # torsocks parses TorAddress itself and rejects anything that is not a
        # literal IP, so a compose service name has to be resolved here. Done per
        # call rather than once at boot: the tor container can come back on a new
        # address, and a stale IP would silently send traffic nowhere.
        try:
            host = socket.gethostbyname(host)
        except OSError as e:
            print(f"[tor] cannot resolve {host}: {e}", flush=True)
        env["TORSOCKS_TOR_ADDRESS"] = host
        env["TORSOCKS_TOR_PORT"] = port or "9050"
    return wdir, env

_CLI_NOISE = ("Launching ", "Save task", "Zingo CLI quit", "Creating a new wallet")

def _clean_cli_output(out):
    lines = [l for l in out.split("\n")
             if l.strip() and not any(l.strip().startswith(p) for p in _CLI_NOISE)]
    return "\n".join(lines).strip()

# A seed is 12 to 24 lowercase words. Anything that shape, in text on its way to
# a client, is treated as key material and never sent.
_SEED_SHAPE = re.compile(r"\b[a-z]+(?: [a-z]+){11,32}\b")

def _safe_cli_error(text):
    """Sanitize CLI output before it can reach a client: drop seed-shaped runs and
    absolute paths (which leak the wallet fingerprint and the server layout)."""
    t = _SEED_SHAPE.sub("[redacted]", text or "")
    t = re.sub(r"(/[\w.\-]+){2,}", "[path]", t)
    return t.strip()[:200] or "CLI error"

def zec(wallet_name, command, args=None):
    wdir, env = wallet_env(wallet_name)
    cmd = cli_prefix() + [CLI, "--chain", CHAIN_NAME, "--server", wallet_server(wallet_name),
                          "--data-dir", wdir, command]
    if args:
        cmd.extend([str(a) for a in args])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env)
        out = _clean_cli_output(r.stdout.strip())
        if r.returncode != 0:
            err = r.stderr.strip() or out
            print(f"[zec] {wallet_name} {command} rc={r.returncode}: {err[:400]}", flush=True)
            raise HTTPException(500, detail="CLI error: " + _safe_cli_error(err))
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return {"raw": out}
    except subprocess.TimeoutExpired:
        raise HTTPException(504, detail="Timeout")
    except FileNotFoundError:
        raise HTTPException(503, detail="CLI not found")

wallet_locks = {}
_restore_sem = None

def restore_sem():
    """Created lazily so it binds to the running loop, like the wallet locks."""
    global _restore_sem
    if _restore_sem is None:
        _restore_sem = asyncio.Semaphore(MAX_CONCURRENT_RESTORES)
    return _restore_sem

def _wlock(wn):
    if wn not in wallet_locks:
        wallet_locks[wn] = asyncio.Lock()
    return wallet_locks[wn]

async def azec(wn, cmd, args=None):
    """All CLI work runs under a per-wallet lock, and a sealed zw_ wallet is
    never touched: without this, an in-flight background task could recreate
    a plaintext dir right after sealing (the CLI makes a FRESH wallet in any
    empty HOME it is pointed at)."""
    async with _wlock(wn):
        if wn.startswith(("zw_", "zai_", "zv_")) and not os.path.isdir(os.path.join(WDIR, wn)):
            raise HTTPException(409, detail="wallet is sealed")
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, zec, wn, cmd, args)

async def aseal(wn):
    """Seal under the same lock so we wait out any in-flight CLI call."""
    async with _wlock(wn):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, seal_wallet, wn)

def parse_balance(raw):
    # `balance` emits JSON, so zec() usually hands us the parsed dict directly.
    # Only fall back to line-parsing when a non-JSON preamble made json.loads fail
    # (in which case zec() wraps the text as {"raw": ...}).
    if isinstance(raw, dict) and "raw" not in raw:
        result = {}
        for k, v in raw.items():
            # numeric balances -> int; leave bools, strings and nested lists alone
            result[k] = int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v
        return result
    out = raw if isinstance(raw, str) else raw.get("raw", "")
    result = {}
    for line in out.split("\n"):
        line = line.strip().rstrip(",")
        if ":" in line and not line.startswith("[") and not line.startswith("]"):
            parts = line.split(":")
            key = parts[0].strip()
            val = parts[1].strip().replace("_", "")
            try:
                result[key] = int(val)
            except ValueError:
                result[key] = val
    # zingo reports per pool as confirmed_/unconfirmed_/total_; alias to the
    # canonical names the frontend reads.
    for pool in ("sapling", "transparent", "orchard"):
        ck = f"confirmed_{pool}_balance"
        if ck in result:
            result.setdefault(f"{pool}_balance", result[ck])
    return result

def parse_transactions(raw):
    out = raw if isinstance(raw, str) else raw.get("raw", "")
    txns = []
    current = None
    depth = 0
    for line in out.split("\n"):
        line = line.strip()
        if not line or line.startswith("Launching") or line.startswith("Save") or line.startswith("Zingo"):
            continue
        if line == "{" and depth == 0:
            current = {}
            depth = 1
        elif line.startswith("{"):
            depth += 1
        elif line == "}" and depth == 1:
            if current and current.get("txid"):
                txns.append(current)
            current = None
            depth = 0
        elif line.startswith("}"):
            depth -= 1
        elif ":" in line and current is not None:
            key = line.split(":")[0].strip()
            val = ":".join(line.split(":")[1:]).strip()
            if val == "not available" or val == "":
                continue
            if key == "memo" and val:
                current["memo"] = val
                continue
            if depth == 1:
                if key in ("value", "fee", "blockheight"):
                    try:
                        val = int(val)
                    except ValueError:
                        pass
                current[key] = val
    return txns

def extract_t_addr(t_result):
    if isinstance(t_result, list):
        for a in t_result:
            if isinstance(a, dict):
                return a.get("encoded_address", "")
    return ""

async def sync_and_cache(wallet_name):
    # Never operate on a wallet that is sealed or gone: the CLI would
    # silently create a FRESH wallet in an empty HOME (post-logout race).
    if not os.path.isdir(os.path.join(WDIR, wallet_name)):
        return None, None
    try:
        await azec(wallet_name, "sync", ["run"])
        bal = await azec(wallet_name, "balance")
        parsed_bal = parse_balance(bal)
        txs = await azec(wallet_name, "value_transfers")
        parsed_txs = txs if isinstance(txs, list) else parse_transactions(txs)
        await azec(wallet_name, "save")
        wallet_cache[wallet_name] = {
            "balance": parsed_bal,
            "transactions": parsed_txs,
            "last_sync": time.time()
        }
        return parsed_bal, parsed_txs
    except Exception as e:
        print(f"Sync error for {wallet_name}: {e}")
        return None, None

async def auto_shield(wallet_name):
    if not os.path.isdir(os.path.join(WDIR, wallet_name)):
        return
    try:
        cached = wallet_cache.get(wallet_name, {})
        bal = cached.get("balance", {})
        t_bal = bal.get("confirmed_transparent_balance", bal.get("tbalance", 0))
        if isinstance(t_bal, int) and t_bal > 20000:
            await azec(wallet_name, "quickshield")
    except Exception:
        pass

# ── ZEC price (server-side cached; users' browsers never hit a price API, so no
#    per-user IP leak to a third party — matters for a privacy app) ──────────────
price_cache = {"usd": None, "usd_24h_change": None, "updated": 0.0}
PRICE_URL = ("https://api.coingecko.com/api/v3/simple/price"
             "?ids=zcash&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true")

def _fetch_zec_price():
    import urllib.request
    req = urllib.request.Request(PRICE_URL, headers={"User-Agent": "zaim/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.loads(r.read().decode())
    z = d.get("zcash", {})
    return z.get("usd"), z.get("usd_24h_change")

async def update_price():
    loop = asyncio.get_event_loop()
    try:
        usd, chg = await loop.run_in_executor(None, _fetch_zec_price)
        if usd is not None:
            price_cache.update({"usd": usd, "usd_24h_change": chg, "updated": time.time()})
    except Exception as e:
        print(f"[price] fetch failed: {e}", flush=True)

async def periodic_price():
    while True:
        await update_price()
        await asyncio.sleep(60)

async def periodic_sync():
    while True:
        await asyncio.sleep(120)
        active_wallets = set()
        for sid, sess in list(sessions.items()):
            wn = sess.get("wallet_name", "")
            if wn:
                active_wallets.add(wn)
        for wn in active_wallets:
            try:
                await sync_and_cache(wn)
                await auto_shield(wn)
            except Exception:
                pass

async def startup_sync():
    await asyncio.sleep(3)
    active_wallets = set()
    for sid, sess in list(sessions.items()):
        wn = sess.get("wallet_name", "")
        if wn:
            active_wallets.add(wn)
    for wn in active_wallets:
        try:
            await sync_and_cache(wn)
        except Exception:
            pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_sessions()
    load_swaps()
    load_vaults()
    load_wallet_servers()
    load_fee_totals()
    sync_task = asyncio.create_task(periodic_sync())
    startup_task = asyncio.create_task(startup_sync())
    price_task = asyncio.create_task(periodic_price())
    seal_task = asyncio.create_task(periodic_seal())
    vault_task = asyncio.create_task(periodic_vaults())
    escrow_task = asyncio.create_task(ensure_escrow())
    yield
    sync_task.cancel()
    startup_task.cancel()
    price_task.cancel()
    seal_task.cancel()
    vault_task.cancel()
    escrow_task.cancel()

app = FastAPI(title="ZAIM API", version="0.9.2", lifespan=lifespan)
# The SPA is served same-origin (nginx proxies /api), so CORS is belt-and-braces.
# Restrict to the known origins; Bearer tokens are used (no cookies), so credentials are off.
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

class OpenReq(BaseModel):
    seed_phrase: str
    birthday: int = 0
    server: str = ""      # optional indexer choice, remembered for this wallet

class ServerReq(BaseModel):
    server: str

class SendReq(BaseModel):
    to_address: str
    amount: float
    memo: Optional[str] = ""

class MsgReq(BaseModel):
    to_address: str
    message: str

SESSION_MAX_SEC = 7 * 86400

def get_session(request: Request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if token not in sessions:
        raise HTTPException(401, detail="Not authenticated")
    s = sessions[token]
    # Sessions used to expire only when a restart pruned the file, so a
    # long-lived process honored ancient tokens forever. Enforce the same
    # 7-day cutoff at request time.
    if time.time() - s.get("created", 0) > SESSION_MAX_SEC:
        sessions.pop(token, None)
        save_sessions()
        raise HTTPException(401, detail="Session expired. Enter your seed to sign in again")
    wn = s.get("wallet_name", "")
    if wn:
        wdir, sealed = _wallet_paths(wn)
        # A sealed wallet cannot serve requests: the key died with the last
        # active period (idle seal or restart). The seed must be entered again.
        if not os.path.isdir(wdir) and os.path.exists(sealed):
            raise HTTPException(401, detail="Wallet is sealed. Enter your seed to unlock it")
        wallet_activity[wn] = time.time()
    return s

@app.get("/api/health")
async def health():
    cli_ok = os.path.exists(CLI)
    active = sealed = 0
    if os.path.exists(WDIR):
        for e in os.listdir(WDIR):
            if e.startswith("_"):
                continue
            if os.path.isdir(os.path.join(WDIR, e)):
                active += 1
            elif e.endswith(".sealed"):
                sealed += 1
    return {"status": "ok" if cli_ok else "degraded", "backend": "zingo-cli (light client)",
            "server": SERVER, "cli_available": cli_ok, "wallets_active": active,
            "wallets_sealed": sealed, "wallets": active + sealed, "sessions": len(sessions),
            # Disclosed so the UI can show the fee BEFORE a payment is sent.
            # A fee nobody mentions is a fee nobody agreed to.
            "fee_bps": FEE_BPS if FEE_ADDRESS else 0}

def _meta_path(wn):
    return os.path.join(WDIR, wn, "zaim-meta.json")

def _addr_from_new_address(res):
    """new_address returns a JSON object describing the created address; the
    encoded string key has shifted across zingolib versions, so hunt for it."""
    if isinstance(res, dict):
        for k in ("address", "encoded_address", "ua", "unified_address"):
            v = res.get(k)
            if isinstance(v, str) and len(v) > 20:
                return v
        for v in res.values():
            if isinstance(v, str) and (v.startswith("u1") or v.startswith("zs1") or v.startswith("t1")):
                return v
        raw = res.get("raw", "")
        m = re.search(r"(u1[0-9a-z]{20,}|zs1[0-9a-z]{20,})", str(raw))
        if m:
            return m.group(1)
    if isinstance(res, list):
        for item in reversed(res):
            a = _addr_from_new_address(item)
            if a:
                return a
    return ""

async def _read_addresses(wn):
    """Addresses are derived once and cached in zaim-meta.json INSIDE the
    wallet dir, so they seal and unseal with the wallet. Derivation order is
    fixed (z then oz), so a fresh restore of the same seed reproduces the
    same addresses."""
    try:
        with open(_meta_path(wn)) as f:
            m = json.load(f)
        if m.get("z_address") or m.get("t_address"):
            return m.get("z_address", ""), m.get("t_address", ""), m.get("ua_address", "")
    except Exception:
        pass
    z = t = ua = ""
    try:
        t = extract_t_addr(await azec(wn, "t_addresses"))
    except Exception:
        pass
    try:
        z = _addr_from_new_address(await azec(wn, "new_address", ["z"]))
    except Exception:
        pass
    try:
        ua = _addr_from_new_address(await azec(wn, "new_address", ["oz"]))
    except Exception:
        pass
    if z or t:
        try:
            with open(_meta_path(wn), "w") as f:
                json.dump({"z_address": z, "t_address": t, "ua_address": ua}, f)
        except Exception:
            pass
    return z, t, ua

def _parse_recovery(res):
    """recovery_info prints pseudo JSON with unquoted keys; regex it out."""
    if isinstance(res, dict) and res.get("seed"):
        return str(res.get("seed", "")), int(res.get("birthday", 0) or 0)
    raw = res.get("raw", "") if isinstance(res, dict) else str(res)
    m = re.search(r"seed phrase:\s*([a-z]+(?: [a-z]+){11,32})", raw)
    mb = re.search(r"birthday:\s*(\d+)", raw)
    return (m.group(1).strip() if m else ""), (int(mb.group(1)) if mb else 0)

def _extract_txid(result):
    """quicksend output: {"txids": [..]} or txid text; require 64 hex chars."""
    if isinstance(result, dict):
        v = result.get("txid") or result.get("txids")
        if isinstance(v, list) and v:
            v = v[0]
        if isinstance(v, str) and re.fullmatch(r"[0-9a-fA-F]{64}", v):
            return v
        m = re.search(r"[0-9a-fA-F]{64}", str(result.get("raw", "")))
        if m:
            return m.group(0)
    return ""

def _new_session(wn, z_addr, t_addr, ua_addr):
    token = str(uuid.uuid4())
    sessions[token] = {"wallet_name": wn, "created": time.time(),
                       "z_address": z_addr, "t_address": t_addr, "ua_address": ua_addr}
    wallet_activity[wn] = time.time()
    save_sessions()
    return token

@app.post("/api/wallet/create")
async def create_wallet(request: Request):
    """Make a brand new wallet. Returns the seed exactly once. The seed IS the
    account: fingerprint names the wallet dir, seed derives the sealing key."""
    throttle_signin(request)   # unauthenticated and it writes a wallet dir per call
    tmp_wn = "new_" + secrets.token_hex(8)
    await azec(tmp_wn, "sync", ["run"])
    await asyncio.sleep(3)
    seed_result = await azec(tmp_wn, "recovery_info")
    seed_text, birthday = _parse_recovery(seed_result)
    if not seed_text:
        shutil.rmtree(os.path.join(WDIR, tmp_wn), ignore_errors=True)
        raise HTTPException(500, detail="Wallet creation failed. No seed was produced")
    norm = normalize_seed(seed_text)
    fp = seed_fingerprint(norm)
    wn = "zw_" + fp
    wdir, _ = _wallet_paths(wn)
    if os.path.isdir(wdir) or os.path.exists(_wallet_paths(wn)[1]):
        shutil.rmtree(os.path.join(WDIR, tmp_wn), ignore_errors=True)
        raise HTTPException(500, detail="Wallet collision. Try again")
    z_addr, t_addr, ua_addr = await _read_addresses(tmp_wn)
    await azec(tmp_wn, "save")
    os.rename(os.path.join(WDIR, tmp_wn), wdir)
    wallet_keys[wn] = seed_key(norm, fp)
    token = _new_session(wn, z_addr, t_addr, ua_addr)
    return {
        "token": token,
        "address": z_addr,
        "t_address": t_addr,
        "seed": {"seed": seed_text, "birthday": birthday},
        "message": "Wallet created. Save the seed, it is the only way in.",
    }

async def _ensure_wallet_open(norm, wn, key, birthday=0):
    """Unseal a cached wallet or restore it from the chain. Shared by the main
    sign-in and the AI account, which is just a second sealed wallet."""
    wdir, sealed = _wallet_paths(wn)
    loop = asyncio.get_event_loop()
    restored = False
    if not os.path.isdir(wdir):
        if os.path.exists(sealed):
            await loop.run_in_executor(None, unseal_wallet, wn, key)
        else:
            # Fresh restore from seed. The seed goes to the CLI process only.
            _, env = wallet_env(wn)
            restore_cmd = cli_prefix() + [CLI, "--chain", CHAIN_NAME, "--server", wallet_server(wn),
                                          "--data-dir", wdir, "--seed", norm]
            if birthday > 0:
                restore_cmd += ["--birthday", str(birthday)]
            restore_cmd += ["sync", "run"]
            try:
                # Cap concurrent restores: each one is a full chain sync, and the
                # box has one core. Without this, a handful of unknown seeds is
                # enough to starve every signed-in user.
                if restore_sem().locked() and MAX_CONCURRENT_RESTORES > 0:
                    print(f"[restore] queueing {wn}, {MAX_CONCURRENT_RESTORES} already running", flush=True)
                async with restore_sem():
                    r = await loop.run_in_executor(None, lambda: subprocess.run(
                        restore_cmd, capture_output=True, text=True, timeout=600, env=env))
                if r.returncode != 0 and "error" in (r.stderr + r.stdout).lower():
                    shutil.rmtree(wdir, ignore_errors=True)
                    # Never echo CLI output here: the seed is in this process's
                    # argv, so anything it prints is potential seed material.
                    print(f"[restore] failed rc={r.returncode} for {wn}", flush=True)
                    raise HTTPException(500, detail="Restore failed. Check the seed phrase and birthday, then try again")
            except subprocess.TimeoutExpired:
                pass  # long rescan; wallet exists, sync continues in the background
            restored = True
    wallet_keys[wn] = key
    try:
        await azec(wn, "save")
    except Exception:
        pass
    return restored

class OpenViewReq(BaseModel):
    ufvk: str
    birthday: int = 0
    server: str = ""

class SpendReq(BaseModel):
    """A single spend authorised by a seed that is not kept.

    The seed arrives, signs one transaction, and is gone when the call
    returns. That is a real and stateable reduction from holding it for a
    whole session — and it is not the same as never seeing it, which needs
    browser-side proving. Say the former, do not imply the latter."""
    seed_phrase: str
    outputs: list[dict]          # [{address, amount, memo?}]
    # Which of the two normal paths this stands in for. A view-only send must
    # end up with the same fee and the same on-chain shape as the equivalent
    # seed-session send, or the choice of sign-in method becomes visible both
    # in our revenue and, worse, in the transaction itself.
    kind: str = "payment"        # "payment" | "message"

async def _spend_once(session, req: SpendReq):
    """Open a throwaway spend-capable wallet from the seed, send, then seal it
    and drop the key. Nothing spendable outlives this call."""
    norm = normalize_seed(req.seed_phrase)
    fp = seed_fingerprint(norm)
    wn = "zw_" + fp
    key = seed_key(norm, fp)
    view_wn = session["wallet_name"]
    # The seed must belong to the viewing key already signed in, or one user
    # could drive a send from another user's wallet through their own session.
    if view_wn.startswith("zv_"):
        expected = session.get("spend_wallet")
        if expected and expected != wn:
            raise HTTPException(403, detail="That seed does not match this session")
    try:
        await _ensure_wallet_open(norm, wn, key)
        result = await azec(wn, "quicksend", [json.dumps(req.outputs)])
        txid = _extract_txid(result)
        if not txid:
            raise HTTPException(500, detail="The send did not return a txid. Check your transactions before retrying")
        session["spend_wallet"] = wn
        save_sessions()
        return txid
    finally:
        # Drop the spend capability immediately, whatever happened above.
        wallet_keys.pop(wn, None)
        try:
            await aseal(wn)
        except Exception:
            pass

@app.post("/api/wallet/send_with_seed")
async def send_with_seed(req: SpendReq, session=Depends(get_session)):
    """Authorise one spend from a view-only session.

    Interim design, and the UI says so: the honest claim is that the seed never
    arrives at sign in or while reading, and arrives only for the moment of a
    send. Browser-side signing removes even that."""
    if not req.outputs or len(req.outputs) > 8:
        raise HTTPException(400, detail="1 to 8 outputs")
    req.outputs, fee_zats = await _apply_fees(session, req.kind, req.outputs)
    txid = await _spend_once(session, req)
    if fee_zats and req.kind == "message":
        wn = session["wallet_name"]
        fee_totals[wn] = fee_totals.get(wn, 0) + fee_zats
        save_fee_totals()
    wallet_cache.pop(session["wallet_name"], None)
    return {"txid": txid, "fee_zats": fee_zats, "fee_zec": fee_zats / 1e8}

async def _apply_fees(session, kind, outputs):
    """Add the same fee output, and the same padding, that the seed-session
    endpoints add. Returns the outputs to sign and the fee charged."""
    if kind == "message":
        reply_addr = session.get("z_address", "")
        out = []
        for o in outputs:
            memo = (o.get("memo") or "") + (f"\nReply-to: {reply_addr}" if reply_addr else "")
            if len(memo.encode("utf-8")) > MEMO_BYTES_MAX:
                raise HTTPException(400, detail="Message too long for a 512 byte memo")
            out.append({"address": o["address"], "amount": DUST, "memo": memo})
        fee_zats = await _msg_fee_zats()
        if fee_zats:
            out.append({"address": TREASURY_ADDRESS, "amount": fee_zats})
        self_addr = session.get("ua_address") or session.get("z_address", "")
        return _pad_outputs(out, self_addr, MSG_ACTIONS), fee_zats

    # Amounts arrive in ZEC, as they do at /api/wallet/send, so there is one
    # unit convention at the API boundary. Converting here rather than in the
    # browser means a client bug cannot quietly send a rounded-down zero.
    out = []
    for o in outputs:
        zats = int((Decimal(str(o.get("amount", 0))) * 100_000_000).to_integral_value(rounding=ROUND_DOWN))
        if zats <= 0:
            raise HTTPException(400, detail="Amount too small")
        e = {"address": o["address"], "amount": zats}
        if o.get("memo"):
            if len(o["memo"].encode("utf-8")) > MEMO_BYTES_MAX:
                raise HTTPException(400, detail="Memo too long for a 512 byte field")
            e["memo"] = o["memo"]
        out.append(e)

    total = sum(o["amount"] for o in out)
    fee_zats = 0
    if FEE_ADDRESS and FEE_BPS > 0 and total > 0:
        fee_zats = max(FEE_MIN_ZATS, total * FEE_BPS // 10000)
        if fee_zats > 0:
            out.append({"address": FEE_ADDRESS, "amount": fee_zats})
    return out, fee_zats

async def _ensure_view_wallet_open(ufvk, wn, key, birthday):
    """Open a view-only wallet, restoring from the UFVK when it is new.

    Same sealing machinery as a seed wallet; the only differences are the
    namespace and that zingo is handed --viewkey instead of --seed. What comes
    out cannot spend, by construction, not by policy."""
    wdir, sealed = _wallet_paths(wn)
    loop = asyncio.get_event_loop()
    restored = False
    if not os.path.isdir(wdir):
        if os.path.exists(sealed):
            await loop.run_in_executor(None, unseal_wallet, wn, key)
        else:
            _, env = wallet_env(wn)
            # A UFVK carries no birthday, so without one we fall back to
            # sapling activation and scan the whole chain. That is slow — hours
            # for a wallet that may be days old — but refusing outright would
            # strand anyone who never wrote their height down. The client is
            # expected to supply it, and to remember it afterwards.
            if birthday <= 0:
                birthday = SAPLING_ACTIVATION.get(CHAIN_NAME, 419200)
            restore_cmd = cli_prefix() + [CLI, "--chain", CHAIN_NAME, "--server", wallet_server(wn),
                                          "--data-dir", wdir, "--viewkey", ufvk,
                                          "--birthday", str(birthday), "sync", "run"]
            try:
                async with restore_sem():
                    r = await loop.run_in_executor(None, lambda: subprocess.run(
                        restore_cmd, capture_output=True, text=True, timeout=600, env=env))
                if r.returncode != 0 and "error" in (r.stderr + r.stdout).lower():
                    shutil.rmtree(wdir, ignore_errors=True)
                    print(f"[viewrestore] failed rc={r.returncode} for {wn}", flush=True)
                    raise HTTPException(500, detail="Could not open that viewing key. Check the birthday height and try again")
            except subprocess.TimeoutExpired:
                pass  # long rescan; the wallet exists and sync continues
            restored = True
    wallet_keys[wn] = key
    try:
        await azec(wn, "save")
    except Exception:
        pass
    return restored

@app.post("/api/wallet/open_view")
async def open_view_wallet(req: OpenViewReq, request: Request):
    """Sign in with a viewing key. The seed never reaches this server.

    The wallet that results can read everything — balances, history, memos
    sent and received — and cannot move a single zatoshi. Spending is a
    separate, explicit act (see /api/wallet/send_with_seed)."""
    throttle_signin(request)
    ufvk = normalize_ufvk(req.ufvk)
    fp = ufvk_fingerprint(ufvk)
    wn = "zv_" + fp
    if req.server:
        chosen = validate_server(req.server)
        if wallet_servers.get(wn) != chosen:
            wallet_servers[wn] = chosen
            save_wallet_servers()
    restored = await _ensure_view_wallet_open(ufvk, wn, ufvk_key(ufvk, fp), req.birthday)
    z_addr, t_addr, ua_addr = await _read_addresses(wn)
    token = _new_session(wn, z_addr, t_addr, ua_addr)
    sessions[token]["view_only"] = True
    save_sessions()
    asyncio.create_task(sync_and_cache(wn))
    return {"token": token, "address": z_addr, "t_address": t_addr,
            "restored": restored, "view_only": True,
            "message": "Syncing from the chain. Balances may take a few minutes" if restored else "Unlocked, read only"}

@app.post("/api/wallet/open")
async def open_wallet(req: OpenReq, request: Request):
    """Sign in with a seed. Unseals the cached wallet if we have it, otherwise
    restores from the chain. Same seed, same wallet, any device."""
    throttle_signin(request)
    norm = normalize_seed(req.seed_phrase)
    fp = seed_fingerprint(norm)
    wn = "zw_" + fp
    key = seed_key(norm, fp)
    # Validate before the seed touches anything, and remember the choice so the
    # next sign-in from any device lands on the same indexer.
    if req.server:
        chosen = validate_server(req.server)
        if wallet_servers.get(wn) != chosen:
            wallet_servers[wn] = chosen
            save_wallet_servers()
    restored = await _ensure_wallet_open(norm, wn, key, req.birthday)
    z_addr, t_addr, ua_addr = await _read_addresses(wn)
    token = _new_session(wn, z_addr, t_addr, ua_addr)
    asyncio.create_task(sync_and_cache(wn))
    return {"token": token, "address": z_addr, "t_address": t_addr,
            "restored": restored,
            "message": "Syncing from the chain. Balances may take a few minutes" if restored else "Unlocked"}

@app.post("/api/wallet/logout")
async def logout_wallet(request: Request, session=Depends(get_session)):
    """Drop this session and seal the wallet if no other session uses it."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    wn = session.get("wallet_name", "")
    sessions.pop(token, None)
    save_sessions()
    sealed = False
    if wn and wn not in _live_wallets():
        sealed = await aseal(wn)
    return {"ok": True, "sealed": bool(sealed)}

@app.get("/api/wallet/balance")
async def get_balance(session=Depends(get_session)):
    wn = session["wallet_name"]
    cached = wallet_cache.get(wn, {})
    cached_bal = cached.get("balance")
    if cached_bal and (time.time() - cached.get("last_sync", 0)) < 30:
        return {"balance": cached_bal}
    if cached_bal:
        asyncio.create_task(sync_and_cache(wn))
        return {"balance": cached_bal}
    try:
        await azec(wn, "sync", ["run"])
    except Exception:
        pass
    bal = await azec(wn, "balance")
    parsed = parse_balance(bal)
    wallet_cache.setdefault(wn, {})["balance"] = parsed
    wallet_cache[wn]["last_sync"] = time.time()
    asyncio.create_task(auto_shield(wn))
    return {"balance": parsed}

@app.get("/api/wallet/address")
async def get_address(session=Depends(get_session)):
    z = session.get("z_address", "")
    t = session.get("t_address", "")
    ua = session.get("ua_address", "")
    if not z or not t:
        z2, t2, ua2 = await _read_addresses(session["wallet_name"])
        z, t, ua = z2 or z, t2 or t, ua2 or ua
        session.update({"z_address": z, "t_address": t, "ua_address": ua})
        save_sessions()
    return {
        "z_address": z,
        "t_address": t,
        "ua_address": ua,
        "addresses": {"z_addresses": [z] if z else [], "t_addresses": [t] if t else []}
    }

@app.post("/api/wallet/send")
async def send_payment(req: SendReq, session=Depends(get_session)):
    wn = session["wallet_name"]
    if req.amount is None or req.amount <= 0:
        raise HTTPException(400, detail="Amount must be positive")
    # Convert ZEC->zatoshis via Decimal to avoid binary-float rounding (e.g. 0.1*1e8).
    zatoshis = int((Decimal(str(req.amount)) * 100_000_000).to_integral_value(rounding=ROUND_DOWN))
    if zatoshis <= 0:
        raise HTTPException(400, detail="Amount too small")
    if req.memo and len(req.memo.encode("utf-8")) > MEMO_BYTES_MAX:
        raise HTTPException(400, detail="The memo is over 512 bytes. Shorten it")
    # Recipient output first; the app fee (if configured) is a second output to
    # the house address in the SAME transaction — atomic, one network fee.
    outputs = [{"address": req.to_address, "amount": zatoshis}]
    if req.memo:
        outputs[0]["memo"] = req.memo
    fee_zats = 0
    if FEE_ADDRESS and FEE_BPS > 0:
        fee_zats = max(FEE_MIN_ZATS, zatoshis * FEE_BPS // 10000)
        if fee_zats > 0:
            outputs.append({"address": FEE_ADDRESS, "amount": fee_zats})
    result = await azec(wn, "quicksend", [json.dumps(outputs)])
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    return {"result": result, "to": req.to_address, "amount": req.amount, "zatoshis": zatoshis,
            "fee_zatoshis": fee_zats, "fee_zec": fee_zats / 1e8}

# An incoming shielded memo carries no sender — that is the protocol doing its
# job, not a bug. So outgoing ZAIM messages embed a reply address in the memo
# itself (the same convention Ywallet uses), and the reader lifts it back out.
# Non-ZAIM wallets just see a readable "Reply-to:" line under the text.
REPLY_TAG_RE = re.compile(r"\n?Reply-to:\s*([a-zA-Z0-9]{20,})\s*$")
MEMO_BYTES_MAX = 511

def _split_reply_tag(memo):
    m = REPLY_TAG_RE.search(memo)
    if not m:
        return memo, ""
    return REPLY_TAG_RE.sub("", memo).rstrip(), m.group(1)

@app.post("/api/message/send")
async def send_message(req: MsgReq, session=Depends(get_session)):
    wn = session["wallet_name"]
    if not req.message or not req.message.strip():
        raise HTTPException(400, detail="The message is empty")
    reply_addr = session.get("z_address", "")
    memo = req.message + (f"\nReply-to: {reply_addr}" if reply_addr else "")
    over = len(memo.encode("utf-8")) - MEMO_BYTES_MAX
    if over > 0:
        raise HTTPException(400, detail=f"Message too long by about {over} characters. "
                                        "A memo holds 512 bytes and the reply address uses some")
    outputs = [{"address": req.to_address, "amount": DUST, "memo": memo}]

    # Treasury output: empty memo, so it carries no conversational content and
    # cannot be mistaken for a message by any reader, including our own inbox.
    fee_zats = await _msg_fee_zats()
    if fee_zats:
        outputs.append({"address": TREASURY_ADDRESS, "amount": fee_zats})

    # Fixed shape regardless of whether a fee rode along.
    outputs = _pad_outputs(outputs, session.get("ua_address") or session.get("z_address", ""), MSG_ACTIONS)

    result = await azec(wn, "quicksend", [json.dumps(outputs)])
    if fee_zats:
        fee_totals[wn] = fee_totals.get(wn, 0) + fee_zats
        save_fee_totals()
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    return {"result": result, "to": req.to_address, "message_preview": req.message[:50],
            "fee_zats": fee_zats}

@app.get("/api/messages")
async def get_messages(session=Depends(get_session)):
    wn = session["wallet_name"]
    try:
        txs = await azec(wn, "value_transfers")
        parsed = txs if isinstance(txs, list) else parse_transactions(txs)
        messages = []
        for tx in parsed:
            if not isinstance(tx, dict):
                continue
            memos = tx.get("memos")
            memo = (memos[0] if isinstance(memos, list) and memos else None) or tx.get("memo")
            if not memo:
                continue
            text, from_addr = _split_reply_tag(str(memo))
            if not text or text.startswith("zaim-vault:") or text.startswith("zaim-sync:"):
                continue  # vault-funding and contact-sync bookkeeping, not conversation
            messages.append({
                "memo": text,
                "from": from_addr,
                "to": tx.get("recipient_address") or tx.get("address") or tx.get("toaddress") or "",
                "txid": tx.get("txid", ""),
                "datetime": tx.get("datetime", ""),
                "height": tx.get("blockheight", ""),
                "amount": (tx.get("value", 0) / 1e8) if isinstance(tx.get("value"), int) else 0,
                "sent": str(tx.get("kind", "")).lower().replace("-", "").replace("_", "")
                        in ("send", "sent", "sendtoself", "memotoself"),
            })
        return {"messages": messages, "count": len(messages)}
    except Exception:
        return {"messages": [], "count": 0}

# ─── Payment requests · ZIP-321 ──────────────────────────────────────────────
# A request is a fresh diversified z-address plus a zcash: URI any wallet can
# pay (Zashi, Ywallet, edge — it is an open standard, not a ZAIM thing). Fresh
# address per request means invoices cannot be linked to each other by the
# payers. Diversified addresses share one viewing key, so a restore from seed
# still finds every payment no matter how many were handed out.
# Requests live in zaim-requests.json INSIDE the wallet dir: they seal and
# unseal with the wallet and never sit in plaintext at rest.

def _requests_path(wn):
    return os.path.join(WDIR, wn, "zaim-requests.json")

def _load_requests(wn):
    try:
        with open(_requests_path(wn)) as f:
            return json.load(f)
    except Exception:
        return []

def _save_requests(wn, lst):
    try:
        _atomic_write_json(_requests_path(wn), lst)
    except Exception as e:
        print(f"[requests] save failed for {wn}: {e}", flush=True)

def _b64url(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def _zip321_uri(address, zats, memo):
    # ZIP-321: amount is decimal ZEC, memo is base64url without padding.
    amount = (Decimal(zats) / Decimal(100_000_000)).quantize(Decimal("0.00000001")).normalize()
    uri = f"zcash:{address}?amount={amount:f}"
    if memo:
        uri += f"&memo={_b64url(memo.encode('utf-8'))}"
    return uri

class RequestCreateReq(BaseModel):
    amount: float
    memo: str = ""

@app.post("/api/request/create")
async def request_create(req: RequestCreateReq, session=Depends(get_session)):
    wn = session["wallet_name"]
    if req.amount is None or req.amount <= 0:
        raise HTTPException(400, detail="Amount must be positive")
    zats = int((Decimal(str(req.amount)) * 100_000_000).to_integral_value(rounding=ROUND_DOWN))
    if zats <= 0:
        raise HTTPException(400, detail="Amount too small")
    if req.memo and len(req.memo.encode("utf-8")) > 400:
        raise HTTPException(400, detail="Keep the note under 400 characters")
    addr = _addr_from_new_address(await azec(wn, "new_address", ["z"]))
    if not addr:
        raise HTTPException(502, detail="Could not derive a fresh address. Try again")
    await azec(wn, "save")
    rec = {
        "id": secrets.token_hex(6), "address": addr, "zats": zats,
        "zec": zats / 1e8, "memo": req.memo or "",
        "uri": _zip321_uri(addr, zats, req.memo or ""),
        "created": time.time(), "paid": False, "txid": "",
    }
    lst = [rec] + _load_requests(wn)
    _save_requests(wn, lst[:50])
    return {"request": rec}

@app.get("/api/request/list")
async def request_list(session=Depends(get_session)):
    """Requests, with paid status refreshed against the wallet's own transfers.
    Match is by the request's unique address; amount+time is the fallback for
    CLI versions that do not expose the receiving address."""
    wn = session["wallet_name"]
    lst = _load_requests(wn)
    if any(not r["paid"] for r in lst):
        try:
            txs = await azec(wn, "value_transfers")
            parsed = txs if isinstance(txs, list) else parse_transactions(txs)
        except Exception:
            parsed = []
        changed = False
        for r in lst:
            if r["paid"]:
                continue
            for t in parsed:
                if not isinstance(t, dict):
                    continue
                kind = str(t.get("kind", "")).lower()
                if "receiv" not in kind:
                    continue
                t_addr = t.get("recipient_address") or t.get("address") or ""
                try:
                    val = int(t.get("value", 0))
                except (TypeError, ValueError):
                    val = 0
                addr_hit = t_addr and t_addr == r["address"]
                amt_hit = not t_addr and val == r["zats"]
                if addr_hit or amt_hit:
                    r["paid"] = True
                    r["txid"] = t.get("txid", "")
                    changed = True
                    break
        if changed:
            _save_requests(wn, lst)
    return {"requests": lst}

# ─── Chain sync · the contact book follows the seed ──────────────────────────
# The address book is the one thing that used to live only in the browser. Now
# it can ride the chain: gzip the JSON, encrypt it with a key derived from the
# seed, split the ciphertext across shielded memos, and send them to yourself
# in ONE transaction (all chunks land or none do). Any device that signs in
# with the seed pulls the newest complete set. No server copy, no third party,
# and the format below is the whole spec, so any wallet could implement it.
#
#   memo = "zaim-sync:v1:<chunk>/<total>:<unix-ts>:<base64 piece>"
#   ciphertext = nonce(12) + AES-256-GCM(gzip(json), aad="zaim-sync-v1")
#   key = PBKDF2-SHA256(normalized seed, salt="zaim-sync-v1:" + wallet-fp, 200k)

SYNC_TAG = "zaim-sync:v1:"
SYNC_MAX_CHUNKS = 16
SYNC_CHUNK_RE = re.compile(r"^zaim-sync:v1:(\d+)/(\d+):(\d+):([A-Za-z0-9+/=]+)$")

async def _sync_key(wn):
    """Derive the sync key from the seed at call time and drop it. The seed is
    read back from the CLI rather than held in server memory between requests."""
    seed_text, _ = _parse_recovery(await azec(wn, "recovery_info"))
    if not seed_text:
        raise HTTPException(502, detail="Could not read the wallet seed to derive the sync key")
    norm = normalize_seed(seed_text)
    return hashlib.pbkdf2_hmac("sha256", norm.encode(), ("zaim-sync-v1:" + wn).encode(), PBKDF2_ITER)

class SyncPushReq(BaseModel):
    contacts: list

@app.post("/api/sync/push")
async def sync_push(req: SyncPushReq, session=Depends(get_session)):
    wn = session["wallet_name"]
    z = session.get("z_address", "")
    if not z:
        z, _, _ = await _read_addresses(wn)
    if not z:
        raise HTTPException(400, detail="The wallet has no shielded address yet")
    payload = json.dumps({"contacts": req.contacts[:500]}, separators=(",", ":")).encode()
    key = await _sync_key(wn)
    nonce = secrets.token_bytes(12)
    blob = nonce + AESGCM(key).encrypt(nonce, gzip.compress(payload), b"zaim-sync-v1")
    b64 = base64.b64encode(blob).decode()
    ts = int(time.time())
    room = MEMO_BYTES_MAX - len(f"{SYNC_TAG}{SYNC_MAX_CHUNKS}/{SYNC_MAX_CHUNKS}:{ts}:")
    pieces = [b64[i:i + room] for i in range(0, len(b64), room)]
    if len(pieces) > SYNC_MAX_CHUNKS:
        raise HTTPException(400, detail=f"The contact book is too large to sync ({len(pieces)} chunks, max {SYNC_MAX_CHUNKS})")
    outputs = [{"address": z, "amount": DUST,
                "memo": f"{SYNC_TAG}{i + 1}/{len(pieces)}:{ts}:{p}"}
               for i, p in enumerate(pieces)]
    result = await azec(wn, "quicksend", [json.dumps(outputs)])
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    txid = _extract_txid(result)
    if not txid:
        raw = json.dumps(result, default=str).lower()
        if "insufficient" in raw or "not enough" in raw or "no funds" in raw:
            raise HTTPException(400, detail="Not enough ZEC to write the sync. It costs about "
                                            f"{(len(pieces) * DUST) / 1e8:.4f} ZEC plus the network fee")
        raise HTTPException(502, detail="The sync did not broadcast. Nothing left your wallet")
    return {"txid": txid, "chunks": len(pieces), "ts": ts,
            "cost_zec": (len(pieces) * DUST) / 1e8}

@app.get("/api/sync/pull")
async def sync_pull(session=Depends(get_session)):
    """Newest complete sync set from the wallet's own memos. Free: reading your
    own chain data costs nothing."""
    wn = session["wallet_name"]
    try:
        txs = await azec(wn, "value_transfers")
        parsed = txs if isinstance(txs, list) else parse_transactions(txs)
    except Exception:
        return {"found": False}
    sets = {}
    for t in parsed:
        if not isinstance(t, dict):
            continue
        memos = t.get("memos") if isinstance(t.get("memos"), list) else []
        if t.get("memo"):
            memos = memos + [t["memo"]]
        for m in memos:
            g = SYNC_CHUNK_RE.match(str(m).strip())
            if not g:
                continue
            n, total, ts = int(g.group(1)), int(g.group(2)), int(g.group(3))
            sets.setdefault(ts, {"total": total, "parts": {}})["parts"][n] = g.group(4)
    key = None
    for ts in sorted(sets, reverse=True):
        s = sets[ts]
        if len(s["parts"]) != s["total"]:
            continue
        try:
            if key is None:
                key = await _sync_key(wn)
            blob = base64.b64decode("".join(s["parts"][i] for i in range(1, s["total"] + 1)))
            data = json.loads(gzip.decompress(AESGCM(key).decrypt(blob[:12], blob[12:], b"zaim-sync-v1")))
            return {"found": True, "ts": ts, "contacts": data.get("contacts", [])}
        except Exception:
            continue  # damaged or foreign set; try the next newest
    return {"found": False}

@app.get("/api/wallet/transactions")
async def get_transactions(session=Depends(get_session)):
    wn = session["wallet_name"]
    cached = wallet_cache.get(wn, {})
    cached_txs = cached.get("transactions")
    if cached_txs is not None and (time.time() - cached.get("last_sync", 0)) < 30:
        return {"transactions": cached_txs}
    if cached_txs is not None:
        asyncio.create_task(sync_and_cache(wn))
        return {"transactions": cached_txs}
    try:
        txs = await azec(wn, "value_transfers")
        parsed = txs if isinstance(txs, list) else parse_transactions(txs)
        wallet_cache.setdefault(wn, {})["transactions"] = parsed
        return {"transactions": parsed}
    except Exception:
        return {"transactions": []}

@app.get("/api/wallet/seed")
async def get_seed(session=Depends(get_session)):
    result = await azec(session["wallet_name"], "recovery_info")
    seed_text, birthday = _parse_recovery(result)
    return {"seed": seed_text, "birthday": birthday}

@app.get("/api/node/info")
async def node_info():
    return {"server": SERVER, "backend": "zingo-cli (zingolib)", "synced": True}

# ── Messenger fee ─────────────────────────────────────────────────────────────
# A flat, USD-quoted fee riding as a second output on every messenger send.
#
# Be clear about what this is: the CLIENT builds the transaction, so the fee is
# a SOFT DEFAULT. A modified or forked client can simply omit it and the
# message still delivers. That is not a bug to be patched — messaging cannot
# enforce payment cryptographically the way a paid API can, and pretending
# otherwise would mean breaking delivery for people whose fee failed. It ships
# behind a flag so it can be turned off, tuned, or replaced outright.
#
# Shape matters as much as the money: every messenger transaction is padded to
# a fixed action count with dummy outputs, so "this send carried a fee" is not
# visible as a different transaction shape to a chain observer.
MESSENGER_FEE_ENABLED = os.getenv("MESSENGER_FEE_ENABLED", "") == "true"
TREASURY_ADDRESS = os.getenv("TREASURY_ADDRESS", "")
MSG_FEE_USD = float(os.getenv("MSG_FEE_USD", "0.03"))
MSG_ACTIONS = int(os.getenv("MSG_ACTIONS", "4"))          # fixed shape, dummies fill

# Scaffolded, all off. Present so the shape of the revenue surface is visible
# in one place rather than discovered later in three.
HOSTED_INFRA_FEE_ENABLED = os.getenv("HOSTED_INFRA_FEE_ENABLED", "") == "true"
SUPPORT_TIP_ENABLED = os.getenv("SUPPORT_TIP_ENABLED", "") == "true"
PREMIUM_FEATURES_ENABLED = os.getenv("PREMIUM_FEATURES_ENABLED", "") == "true"

def _usd_to_zats(usd, zec_usd):
    return int(round(usd / zec_usd * 1e8)) if zec_usd else 0

async def _msg_fee_zats():
    """Current messenger fee in zatoshis, or 0 when disabled/unpriced. Quoted in
    USD so the cost stays stable as ZEC moves."""
    if not (MESSENGER_FEE_ENABLED and TREASURY_ADDRESS):
        return 0
    now = time.time()
    if now - _ai_price_cache["t"] > 60:
        loop = asyncio.get_event_loop()
        try:
            usd, _ = await loop.run_in_executor(None, _fetch_zec_price)
            if usd:
                _ai_price_cache.update(t=now, usd=usd)
        except Exception:
            pass
    zats = _usd_to_zats(MSG_FEE_USD, _ai_price_cache["usd"])
    # A fee below dust cannot be an output at all; treat as unpriced.
    return zats if zats >= DUST else 0

def _pad_outputs(outputs, self_addr, target_actions):
    """Pad to a fixed output count with dust-to-self, so a send that carries a
    fee is indistinguishable in shape from one that does not."""
    if not self_addr:
        return outputs
    padded = list(outputs)
    while len(padded) < target_actions:
        padded.append({"address": self_addr, "amount": DUST})
    return padded

@app.get("/api/fees")
async def fee_info(session=Depends(get_session)):
    """What a message costs right now, for the send confirmation UI."""
    zats = await _msg_fee_zats()
    return {
        "messenger_fee_enabled": MESSENGER_FEE_ENABLED and bool(TREASURY_ADDRESS),
        "msg_fee_zats": zats,
        "msg_fee_usd": MSG_FEE_USD,
        "zec_usd": _ai_price_cache["usd"],
        "actions": MSG_ACTIONS,
        "lifetime_fees_zats": fee_totals.get(session["wallet_name"], 0),
        "scaffold": {
            "hosted_infra_fee": HOSTED_INFRA_FEE_ENABLED,
            "support_tip": SUPPORT_TIP_ENABLED,
            "premium_features": PREMIUM_FEATURES_ENABLED,
        },
    }

# ── AI tab ────────────────────────────────────────────────────────────────────
# The server's role here is deliberately dumb: open a second sealed wallet
# (seed derived CLIENT-side from the main seed — see src/ai/derive.js), move
# funds into it, forward opaque base64 memo chunks, and hand ciphertext back.
# Question plaintext is sealed to the relay's X25519 key in the browser and
# answers are sealed to a browser-held ephemeral key, so this process never
# sees either. What it does see, and the UI says so: that this account used
# the AI tab, when, and what it paid.

AI_RELAY_ADDRESS = os.getenv("AI_RELAY_ADDRESS", "")          # unset = mock mode, /api/ai/send disabled
AI_RELAY_PUBKEY = os.getenv("AI_RELAY_PUBKEY", "")            # relay X25519, hex, served to the client
AI_REPLY_COST_ZATS = int(os.getenv("AI_REPLY_COST_ZATS", "40000"))   # 8 padded actions
AI_SEND_COST_ZATS = int(os.getenv("AI_SEND_COST_ZATS", "10000"))     # user's own tx fee, shown not charged
AI_INFERENCE_USD = float(os.getenv("AI_INFERENCE_USD", "0.01"))
AI_ZAIM_FEE_USD = float(os.getenv("AI_ZAIM_FEE_USD", "0.30"))
AI_PRICE_BUFFER = float(os.getenv("AI_PRICE_BUFFER", "1.10"))        # 10% volatility buffer

class AiOpenReq(BaseModel):
    seed_phrase: str   # the DERIVED AI seed; the main seed never appears here

class AiTopupReq(BaseModel):
    amount_zats: int

class AiSendReq(BaseModel):
    amount_zats: int
    memo_chunks_b64: list[str]   # opaque ZAI1 ciphertext, already base64

def _ai_wallet(session):
    wn = session.get("ai_wallet")
    if not wn:
        raise HTTPException(409, detail="Open the AI account first")
    return wn

@app.post("/api/ai/open")
async def ai_open(req: AiOpenReq, session=Depends(get_session)):
    """Open (or create by restore) this user's AI wallet. Same sealing
    machinery as the main wallet; the fingerprint namespace is zai_."""
    norm = normalize_seed(req.seed_phrase)
    fp = seed_fingerprint(norm)
    wn = "zai_" + fp
    restored = await _ensure_wallet_open(norm, wn, seed_key(norm, fp))
    session["ai_wallet"] = wn
    save_sessions()
    bal = parse_balance(await azec(wn, "balance"))
    height = 0
    try:
        h = await azec(wn, "height")
        height = int(h.get("height", 0)) if isinstance(h, dict) else 0
    except Exception:
        pass
    return {"restored": restored, "balance": bal, "height": height,
            "relay_configured": bool(AI_RELAY_ADDRESS and AI_RELAY_PUBKEY)}

@app.get("/api/ai/balance")
async def ai_balance(session=Depends(get_session)):
    return {"balance": parse_balance(await azec(_ai_wallet(session), "balance"))}

@app.post("/api/ai/address")
async def ai_address(session=Depends(get_session)):
    """Fresh diversified orchard-only address on the AI account (reply addr)."""
    res = await azec(_ai_wallet(session), "new_address", ["o"])
    addr = res.get("address") if isinstance(res, dict) else None
    if not addr:
        # zingo prints the address list; last entry is the new one
        try:
            addr = res[-1]["encoded_address"] if isinstance(res, list) else str(res.get("raw", ""))[:0]
        except Exception:
            addr = ""
    if not addr:
        raise HTTPException(500, detail="Could not derive a reply address")
    return {"address": addr}

@app.post("/api/ai/topup")
async def ai_topup(req: AiTopupReq, session=Depends(get_session)):
    """Internal shielded transfer, main wallet -> AI wallet."""
    if req.amount_zats < DUST:
        raise HTTPException(400, detail="Amount too small")
    ai_wn = _ai_wallet(session)
    res = await azec(ai_wn, "new_address", ["o"])
    dest = res.get("address") if isinstance(res, dict) else (res[-1].get("encoded_address") if isinstance(res, list) and res else None)
    if not dest:
        raise HTTPException(500, detail="Could not derive a top-up address")
    outputs = [{"address": dest, "amount": req.amount_zats}]
    result = await azec(session["wallet_name"], "quicksend", [json.dumps(outputs)])
    txid = _extract_txid(result)
    if not txid:
        raise HTTPException(500, detail="Top-up did not return a txid")
    return {"txid": txid, "amount_zats": req.amount_zats}

@app.post("/api/ai/send")
async def ai_send(req: AiSendReq, session=Depends(get_session)):
    """One shielded tx from the AI wallet to the relay: quoted price on the
    first output, every output carrying an opaque ciphertext chunk."""
    if not AI_RELAY_ADDRESS:
        raise HTTPException(503, detail="No relay is configured yet. The AI tab is in preview")
    if not (1 <= len(req.memo_chunks_b64) <= 8):
        raise HTTPException(400, detail="1 to 8 memo chunks")
    for c in req.memo_chunks_b64:
        if len(c) > 512:
            raise HTTPException(400, detail="Memo chunk exceeds 512 bytes")
        try:
            base64.b64decode(c, validate=True)
        except Exception:
            raise HTTPException(400, detail="Memo chunks must be base64")
    outputs = [{"address": AI_RELAY_ADDRESS,
                "amount": req.amount_zats if i == 0 else DUST,
                "memo": chunk}
               for i, chunk in enumerate(req.memo_chunks_b64)]
    result = await azec(_ai_wallet(session), "quicksend", [json.dumps(outputs)])
    txid = _extract_txid(result)
    if not txid:
        raise HTTPException(500, detail="Send did not return a txid")
    return {"txid": txid}

@app.get("/api/ai/inbox")
async def ai_inbox(session=Depends(get_session)):
    """Ciphertext chunks received on the AI wallet. The server forwards raw
    base64 memos whose decoded bytes start with the ZAI1 magic; parsing and
    decryption happen in the browser."""
    wn = _ai_wallet(session)
    try:
        res = await azec(wn, "messages")
    except HTTPException:
        return {"memos": []}
    out = []
    items = res if isinstance(res, list) else res.get("messages", []) if isinstance(res, dict) else []
    for m in items:
        memo = m.get("memo", "") if isinstance(m, dict) else ""
        try:
            raw = base64.b64decode(memo, validate=True)
        except Exception:
            continue
        if raw[:4] == b"ZAI1":
            out.append({"memo_b64": memo, "txid": m.get("txid", ""), "datetime": m.get("datetime", 0)})
    return {"memos": out}

_ai_price_cache = {"t": 0.0, "usd": 0.0}

@app.get("/api/ai/quote")
async def ai_quote():
    """Price of one question, quoted in USD components and converted to ZEC at
    spot with the volatility buffer. Flat for everyone, by design."""
    now = time.time()
    if now - _ai_price_cache["t"] > 60:
        loop = asyncio.get_event_loop()
        try:
            usd, _ = await loop.run_in_executor(None, _fetch_zec_price)
            if usd:
                _ai_price_cache.update(t=now, usd=usd)
        except Exception:
            pass
    zec_usd = _ai_price_cache["usd"]
    if not zec_usd:
        raise HTTPException(503, detail="Price feed unavailable; try again shortly")
    usd_to_zats = lambda u: int(round(u / zec_usd * 1e8 * AI_PRICE_BUFFER))
    components = {
        "reply_network_zats": AI_REPLY_COST_ZATS,
        "inference_zats": usd_to_zats(AI_INFERENCE_USD),
        "zaim_fee_zats": usd_to_zats(AI_ZAIM_FEE_USD),
    }
    total = sum(components.values())
    return {"zec_usd": zec_usd, "buffer": AI_PRICE_BUFFER,
            "send_fee_zats": AI_SEND_COST_ZATS,   # paid by the user's own tx, shown for honesty
            **components, "total_zats": total,
            "total_usd": round(total / 1e8 * zec_usd, 2),
            "relay_pubkey": AI_RELAY_PUBKEY,
            "relay_configured": bool(AI_RELAY_ADDRESS and AI_RELAY_PUBKEY)}

@app.get("/api/servers")
async def list_servers():
    """The indexers this instance will talk to. `same_operator` is the honest
    caveat: a picker that only offers one operator is not decentralization."""
    labels = dict(DEFAULT_SERVERS)
    return {
        "servers": [{"url": u, "label": labels.get(u, u)} for u in ALLOWED_SERVERS],
        "default": SERVER,
        "any_allowed": ALLOW_ANY_SERVER,
        "same_operator": len({u.split("//")[-1].split(":")[0].split(".")[-2:][0]
                              for u in ALLOWED_SERVERS}) <= 1,
    }

@app.get("/api/settings/server")
async def get_wallet_server(session=Depends(get_session)):
    wn = session["wallet_name"]
    return {"server": wallet_server(wn), "is_default": wn not in wallet_servers}

@app.post("/api/settings/server")
async def set_wallet_server(req: ServerReq, session=Depends(get_session)):
    """Repoint this wallet at another indexer. Takes effect on the next CLI call;
    nothing about the wallet itself changes, only who it asks for chain data."""
    wn = session["wallet_name"]
    chosen = validate_server(req.server)
    if req.server.strip():
        wallet_servers[wn] = chosen
    else:
        wallet_servers.pop(wn, None)
    save_wallet_servers()
    return {"server": wallet_server(wn), "is_default": wn not in wallet_servers}

@app.get("/api/price")
async def get_price():
    # Served from the 60s server-side cache. If it's stale (e.g. just booted),
    # refresh once inline so the first caller still gets a number.
    if price_cache["usd"] is None or (time.time() - price_cache["updated"]) > 90:
        await update_price()
    age = time.time() - price_cache["updated"] if price_cache["updated"] else None
    return {
        "usd": price_cache["usd"],
        "usd_24h_change": price_cache["usd_24h_change"],
        "updated_at": price_cache["updated"] or None,
        "age_seconds": int(age) if age is not None else None,
        "source": "coingecko",
    }

# ─── Swap · NEAR Intents 1Click ──────────────────────────────────────────────
# Cross-chain swaps in and out of ZEC via the 1Click intent API.
#   BUY  (asset → ZEC): quote returns a one-time deposit address; the user pays
#        it from an external wallet; solvers deliver ZEC to the user's
#        transparent address (the periodic auto-shield then moves it private).
#   SELL (ZEC → asset): quote first, then /swap/execute sends the user's ZEC to
#        the quote's deposit address via zecwallet-cli. The deposit address is
#        ONLY ever read from that user's own stored quote — never from client
#        input — so execute can't be steered to an arbitrary address.

INTENTS_BASE = os.getenv("ZAIM_INTENTS_BASE", "https://1click.chaindefuser.com")
INTENTS_KEY = os.getenv("ZAIM_INTENTS_KEY", "")
# Cloudflare in front of the API rejects default python UAs; send a browser UA.
INTENTS_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126 Safari/537.36")
SWAP_SLIPPAGE_BPS = int(os.getenv("ZAIM_SWAP_SLIPPAGE_BPS", "100"))  # 100 = 1%
SWAP_DEADLINE_MIN = int(os.getenv("ZAIM_SWAP_DEADLINE_MIN", "30"))

ZEC_ASSET = {"assetId": "nep141:zec.omft.near", "decimals": 8, "chain": "zcash", "symbol": "ZEC"}
# Asset IDs verified live against GET /v0/tokens on 2026-07-18.
SWAP_ASSETS = {
    "BTC":      {"assetId": "nep141:btc.omft.near", "decimals": 8,  "chain": "bitcoin",  "symbol": "BTC"},
    "ETH":      {"assetId": "nep141:eth.omft.near", "decimals": 18, "chain": "ethereum", "symbol": "ETH"},
    "SOL":      {"assetId": "nep141:sol.omft.near", "decimals": 9,  "chain": "solana",   "symbol": "SOL"},
    "USDC":     {"assetId": "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
                 "decimals": 6, "chain": "solana", "symbol": "USDC"},
    "USDC-ETH": {"assetId": "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
                 "decimals": 6, "chain": "ethereum", "symbol": "USDC"},
}

swaps = {}
SWAPS_FILE = os.path.join(WDIR, "_swaps.json")

def save_swaps():
    try:
        _atomic_write_json(SWAPS_FILE, swaps)
    except Exception as e:
        print(f"[save_swaps] {e}", flush=True)

def load_swaps():
    global swaps
    try:
        if os.path.exists(SWAPS_FILE):
            with open(SWAPS_FILE) as f:
                swaps = json.load(f)
    except Exception:
        pass

def _intents_request(path, body=None, params=None):
    import urllib.request, urllib.parse, urllib.error
    url = INTENTS_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": INTENTS_UA}
    if INTENTS_KEY:
        # The 1Click signup issues a JWT (Bearer); plain keys go in X-API-Key.
        if INTENTS_KEY.count(".") == 2:
            headers["Authorization"] = "Bearer " + INTENTS_KEY
        else:
            headers["X-API-Key"] = INTENTS_KEY
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("message", "")
        except Exception:
            msg = ""
        if isinstance(msg, list):
            msg = "; ".join(str(m) for m in msg)
        raise HTTPException(502, detail=f"Swap service {e.code}: {msg or 'request rejected'}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=f"Swap service unreachable: {e}")

async def aintents(path, body=None, params=None):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _intents_request(path, body, params))

# Coarse shape check only — 1Click validates addresses per-chain and its error
# message is surfaced verbatim to the user.
SWAP_ADDR_RE = re.compile(r"^[A-Za-z0-9:_.-]{10,120}$")

TERMINAL_SWAP_STATES = ("SUCCESS", "REFUNDED", "FAILED", "EXPIRED", "CANCELLED")

class SwapQuoteReq(BaseModel):
    direction: str                 # "buy" (asset → ZEC) | "sell" (ZEC → asset)
    asset: str                     # key in SWAP_ASSETS
    amount: str                    # human units of the INPUT side
    refund_address: str = ""       # buy: user's origin-chain address (required)
    recipient_address: str = ""    # sell: user's destination address (required)
    dry: bool = True

class SwapExecuteReq(BaseModel):
    swap_id: str

class SwapCancelReq(BaseModel):
    swap_id: str

def _to_base_units(amount_str, decimals):
    try:
        d = Decimal(str(amount_str))
    except Exception:
        raise HTTPException(400, detail="Invalid amount")
    if d <= 0:
        raise HTTPException(400, detail="Amount must be positive")
    units = int((d * (Decimal(10) ** decimals)).to_integral_value(rounding=ROUND_DOWN))
    if units <= 0:
        raise HTTPException(400, detail="Amount too small")
    return units

def _quote_view(q, fallback_deadline):
    return {
        "amount_in": q.get("amountInFormatted"),
        "amount_in_usd": q.get("amountInUsd"),
        "amount_out": q.get("amountOutFormatted"),
        "amount_out_usd": q.get("amountOutUsd"),
        "min_amount_out": q.get("minAmountOut"),
        "time_estimate_sec": q.get("timeEstimate"),
        "deadline": q.get("deadline") or fallback_deadline,
    }

@app.get("/api/swap/assets")
async def swap_assets(session=Depends(get_session)):
    return {
        "assets": {k: {"chain": v["chain"], "symbol": v["symbol"], "decimals": v["decimals"]}
                   for k, v in SWAP_ASSETS.items()},
        "zec_decimals": 8,
        "slippage_bps": SWAP_SLIPPAGE_BPS,
    }

@app.post("/api/swap/quote")
async def swap_quote(req: SwapQuoteReq, session=Depends(get_session)):
    if req.direction not in ("buy", "sell"):
        raise HTTPException(400, detail="Direction must be buy or sell")
    asset = SWAP_ASSETS.get(req.asset)
    if not asset:
        raise HTTPException(400, detail="Unknown asset")
    t_addr = session.get("t_address", "")
    if not t_addr:
        _, t_addr, _ = await _read_addresses(session["wallet_name"])
        if t_addr:
            session["t_address"] = t_addr
            save_sessions()
    if not t_addr:
        raise HTTPException(400, detail="The wallet has no transparent address yet. Try again in a minute")

    from datetime import timedelta, timezone as _tz
    deadline = (datetime.now(_tz.utc) + timedelta(minutes=SWAP_DEADLINE_MIN)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    if req.direction == "buy":
        # ZEC lands at the user's transparent address; refunds go back to the
        # external wallet the user pays from.
        if not req.refund_address or not SWAP_ADDR_RE.match(req.refund_address):
            raise HTTPException(400, detail="A refund address on the origin chain is required")
        origin, dest = asset, ZEC_ASSET
        recipient, refund_to = t_addr, req.refund_address
    else:
        # ZEC leaves the user's wallet; refunds (if the swap dies) come back to
        # their own transparent address.
        if not req.recipient_address or not SWAP_ADDR_RE.match(req.recipient_address):
            raise HTTPException(400, detail="A destination address is required")
        origin, dest = ZEC_ASSET, asset
        recipient, refund_to = req.recipient_address, t_addr

    amount_units = _to_base_units(req.amount, origin["decimals"])
    body = {
        "dry": bool(req.dry),
        "swapType": "EXACT_INPUT",
        "slippageTolerance": SWAP_SLIPPAGE_BPS,
        "originAsset": origin["assetId"],
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": dest["assetId"],
        "amount": str(amount_units),
        "refundTo": refund_to,
        "refundType": "ORIGIN_CHAIN",
        "recipient": recipient,
        "recipientType": "DESTINATION_CHAIN",
        "deadline": deadline,
    }
    resp = await aintents("/v0/quote", body=body)
    q = resp.get("quote", {}) or {}
    view = _quote_view(q, deadline)

    if req.dry:
        return {"dry": True, "direction": req.direction, "asset": req.asset, "quote": view}

    deposit_address = q.get("depositAddress", "")
    if not deposit_address:
        raise HTTPException(502, detail="The swap service returned no deposit address")
    sid = str(uuid.uuid4())
    rec = {
        "id": sid,
        "user_id": session["wallet_name"],
        "direction": req.direction,
        "asset": req.asset,
        "chain": asset["chain"],
        "amount_units": str(amount_units),
        "deposit_address": deposit_address,
        "deposit_memo": q.get("depositMemo", "") or "",
        "recipient": recipient,
        "refund_to": refund_to,
        "quote": view,
        "status": "AWAITING_DEPOSIT" if req.direction == "buy" else "READY_TO_SEND",
        "created": time.time(),
        "updated": time.time(),
        "correlation_id": resp.get("correlationId", ""),
        "txid": "",
    }
    swaps[sid] = rec
    save_swaps()
    return {"dry": False, "swap": rec}

@app.post("/api/swap/execute")
async def swap_execute(req: SwapExecuteReq, session=Depends(get_session)):
    """Sell side only: send the user's ZEC to their own quote's deposit address."""
    rec = swaps.get(req.swap_id)
    if not rec or rec.get("user_id") != session["wallet_name"]:
        raise HTTPException(404, detail="Swap not found")
    if rec.get("direction") != "sell":
        raise HTTPException(400, detail="Only sell swaps execute on the server")
    if rec.get("status") != "READY_TO_SEND":
        raise HTTPException(409, detail=f"The swap is {rec.get('status')}")
    if rec.get("deposit_memo"):
        raise HTTPException(400, detail="Memo deposits are not supported for ZEC")
    dl = (rec.get("quote") or {}).get("deadline", "")
    try:
        dl_ts = datetime.fromisoformat(dl.replace("Z", "+00:00")).timestamp()
    except Exception:
        dl_ts = 0
    if dl_ts and dl_ts - time.time() < 60:
        rec["status"] = "EXPIRED"
        rec["updated"] = time.time()
        save_swaps()
        raise HTTPException(409, detail="The quote expired. Get a fresh one")

    wn = session["wallet_name"]
    zats = int(rec["amount_units"])
    outputs = [{"address": rec["deposit_address"], "amount": zats}]
    result = await azec(wn, "quicksend", [json.dumps(outputs)])
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    txid = _extract_txid(result)
    err_text = ""
    if not txid and isinstance(result, dict):
        err_text = str(result.get("raw", "") or result.get("error", ""))[:200]
    if not re.fullmatch(r"[0-9a-fA-F]{64}", txid or "x"):
        # zecwallet-cli exits 0 on some failures (e.g. insufficient funds) and
        # only reports the problem in its output. No txid means NOTHING was
        # broadcast — refuse loudly and keep the swap READY_TO_SEND so a
        # funded retry can still use it. Never record a send that didn't
        # happen (the MAXPAIN phantom-close lesson).
        raise HTTPException(400, detail="Send failed. Nothing was broadcast: "
                            + (err_text or "wallet returned no txid"))
    rec["status"] = "DEPOSIT_SENT"
    rec["txid"] = txid
    rec["updated"] = time.time()
    save_swaps()
    if rec["txid"]:
        # Best-effort: telling 1Click about the tx speeds up solver pickup.
        try:
            await aintents("/v0/deposit/submit",
                           body={"txHash": rec["txid"], "depositAddress": rec["deposit_address"]})
        except Exception:
            pass
    return {"swap": rec}

@app.post("/api/swap/cancel")
async def swap_cancel(req: SwapCancelReq, session=Depends(get_session)):
    """Mark an unfunded swap CANCELLED. Only allowed while nothing has moved:
    buys before any deposit is detected, sells before execute. Cancel is a
    local bookkeeping state. The upstream quote simply lapses unpaid at its
    deadline. If someone pays a cancelled buy quote anyway, the ZEC still
    lands at the user's own address."""
    rec = swaps.get(req.swap_id)
    if not rec or rec.get("user_id") != session["wallet_name"]:
        raise HTTPException(404, detail="Swap not found")
    if rec.get("status") in TERMINAL_SWAP_STATES:
        return {"swap": rec}
    if rec.get("direction") == "sell":
        if rec.get("status") != "READY_TO_SEND":
            raise HTTPException(409, detail=f"Cannot cancel while {rec.get('status')}")
    else:
        if rec.get("status") not in ("AWAITING_DEPOSIT", "PENDING_DEPOSIT"):
            raise HTTPException(409, detail=f"Cannot cancel while {rec.get('status')}")
        # Live check upstream: if a deposit was already seen, it is too late.
        try:
            st = await aintents("/v0/status", params={"depositAddress": rec["deposit_address"]})
            remote = st.get("status", "")
            if remote and remote != "PENDING_DEPOSIT":
                rec["status"] = remote
                rec["updated"] = time.time()
                save_swaps()
                raise HTTPException(409, detail="A deposit was already detected. The swap will complete or refund on its own")
        except HTTPException as e:
            if e.status_code == 409:
                raise
            # service hiccup: an unpaid quote is still safe to cancel
        except Exception:
            pass
    rec["status"] = "CANCELLED"
    rec["updated"] = time.time()
    save_swaps()
    return {"swap": rec}

@app.get("/api/swap/list")
async def swap_list(session=Depends(get_session)):
    mine = [r for r in swaps.values() if r.get("user_id") == session["wallet_name"]]
    mine.sort(key=lambda r: r.get("created", 0), reverse=True)
    return {"swaps": mine[:20]}

@app.get("/api/swap/status/{swap_id}")
async def swap_status(swap_id: str, session=Depends(get_session)):
    rec = swaps.get(swap_id)
    if not rec or rec.get("user_id") != session["wallet_name"]:
        raise HTTPException(404, detail="Swap not found")
    if rec.get("status") in TERMINAL_SWAP_STATES:
        return {"swap": rec}
    params = {"depositAddress": rec["deposit_address"]}
    if rec.get("deposit_memo"):
        params["depositMemo"] = rec["deposit_memo"]
    try:
        st = await aintents("/v0/status", params=params)
    except HTTPException:
        # Right after quote creation the service may briefly not know the
        # address; keep our local state rather than erroring the poll.
        return {"swap": rec}
    remote = st.get("status", "")
    if remote:
        # PENDING_DEPOSIT must not overwrite the richer local sell state
        # (we already broadcast the ZEC; the solver just hasn't seen it).
        if not (rec.get("direction") == "sell" and remote == "PENDING_DEPOSIT"
                and rec.get("status") == "DEPOSIT_SENT"):
            rec["status"] = remote
    details = st.get("swapDetails") or {}
    if isinstance(details, dict) and details:
        dest_txs = details.get("destinationChainTxHashes") or []
        dest_tx = ""
        if isinstance(dest_txs, list) and dest_txs:
            first = dest_txs[0]
            dest_tx = first.get("hash", "") if isinstance(first, dict) else str(first)
        rec["details"] = {
            "amount_in": details.get("amountInFormatted") or details.get("amountIn"),
            "amount_out": details.get("amountOutFormatted") or details.get("amountOut"),
            "dest_tx": dest_tx,
        }
    rec["updated"] = time.time()
    save_swaps()
    return {"swap": rec}

# ─── GeoVault · escrowed location drops ───────────────────────────────────────
# A vault is ZEC parked in a server-held escrow wallet plus a message, released
# to the first wallet that shows up inside a radius during a time window.
# Money moves twice: creator -> escrow when the vault is created, escrow ->
# claimer when it is opened (or escrow -> creator when the window closes unused).
#
# Two honest limits, stated here so nobody has to read the code to find them:
#   1. The location check runs on THIS side, not in the browser, but the
#      coordinates still come from the claimer's device and a device can lie.
#      Vaults are small-value drops, not a settlement layer.
#   2. Messages are encrypted at rest with a server key and delivered inside
#      the payout's shielded memo. In transit to the claimer that is real E2E
#      encryption; at rest the server can read them, because the server has to
#      hand the text to the CLI at claim time. Custodial design, custodial trust.

ESCROW_WN = "_escrow"                 # leading underscore: never sealed, never counted as a user wallet
GEO_FILE = os.path.join(WDIR, "_geovaults.json")
VAULT_KEY_FILE = os.path.join(WDIR, "_vault_key")
VAULT_MIN_ZATS = 100_000                                              # 0.001 ZEC
VAULT_MAX_ZATS = int(float(os.getenv("ZAIM_VAULT_MAX_ZEC", "5")) * 1e8)
PAYOUT_RESERVE = 30_000               # held back per vault to pay the claim or refund network fee
MAX_RADIUS_M = 2000
MAX_ACCURACY_M = 300                  # a fix vaguer than this proves nothing
MAX_WINDOW_SEC = 90 * 86400
FUNDING_GRACE_SEC = 2 * 3600          # unmatched funding tx after this = give up on the vault
MEMO_MAX = 400                        # zcash memo is 512 bytes; leave room for the label line

vaults = {}
geo_lock = asyncio.Lock()             # single uvicorn worker, so this is the whole story on races
escrow_addr = {"z": "", "t": "", "ua": ""}

def save_vaults():
    try:
        _atomic_write_json(GEO_FILE, vaults)
    except Exception as e:
        print(f"[save_vaults] {e}", flush=True)

def load_vaults():
    global vaults
    try:
        if os.path.exists(GEO_FILE):
            with open(GEO_FILE) as f:
                vaults = json.load(f)
    except Exception:
        vaults = {}

def _vault_key():
    """Key for message-at-rest encryption. Generated once, kept 0600 next to the
    wallets so a stolen _geovaults.json alone is not a pile of plaintext."""
    try:
        if os.path.exists(VAULT_KEY_FILE):
            with open(VAULT_KEY_FILE, "rb") as f:
                k = f.read()
            if len(k) == 32:
                return k
        k = secrets.token_bytes(32)
        fd = os.open(VAULT_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(k)
        return k
    except Exception as e:
        print(f"[vault_key] {e}", flush=True)
        raise HTTPException(500, detail="Vault storage is not available")

def enc_msg(text):
    if not text:
        return ""
    nonce = secrets.token_bytes(12)
    blob = nonce + AESGCM(_vault_key()).encrypt(nonce, text.encode(), b"zaim-vault-v1")
    return blob.hex()

def dec_msg(hexblob):
    if not hexblob:
        return ""
    try:
        blob = bytes.fromhex(hexblob)
        return AESGCM(_vault_key()).decrypt(blob[:12], blob[12:], b"zaim-vault-v1").decode()
    except Exception:
        return ""

def haversine_m(lat1, lng1, lat2, lng2):
    import math
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

async def ensure_escrow():
    """Bring up the escrow wallet if it is not there. zingo-cli makes a fresh
    wallet in any empty data dir, which is exactly what we want once and never
    again — the dir is bind-mounted, so it survives restarts and rebuilds."""
    wdir = os.path.join(WDIR, ESCROW_WN)
    fresh = not os.path.isdir(wdir)
    try:
        await azec(ESCROW_WN, "sync", ["run"])
        if fresh:
            await asyncio.sleep(2)
            await azec(ESCROW_WN, "save")
            print("[escrow] created a new escrow wallet. Back up its seed via "
                  "GET /api/admin/escrow before putting real value in it.", flush=True)
        z, t, ua = await _read_addresses(ESCROW_WN)
        escrow_addr.update({"z": z, "t": t, "ua": ua})
        return bool(z or ua)
    except Exception as e:
        print(f"[escrow] not available: {e}", flush=True)
        return False

def _escrow_pay_addr():
    return escrow_addr.get("z") or escrow_addr.get("ua") or ""

def _claim_addr(session):
    return session.get("z_address") or session.get("ua_address") or ""

def _vault_public(v, viewer_wn=None, lat=None, lng=None):
    """What a caller is allowed to see. The message is never included: it is
    delivered by shielded memo when the vault is claimed, and nowhere else."""
    mine = viewer_wn is not None and v.get("creator_wn") == viewer_wn
    out = {
        "id": v["id"], "label": v.get("label", ""), "lat": v["lat"], "lng": v["lng"],
        "radius": v["radius"], "zec": v["zats"] / 1e8, "status": v["status"],
        "opens_at": v["opens_at"], "closes_at": v["closes_at"],
        "has_message": bool(v.get("message_enc")),
        "gated": bool(v.get("target_address")),
        "mine": mine, "created": v.get("created", 0),
        "claimed_by_me": viewer_wn is not None and v.get("claimed_wn") == viewer_wn,
        "claim_txid": v.get("claim_txid", "") if (mine or v.get("claimed_wn") == viewer_wn) else "",
        "fund_txid": v.get("fund_txid", "") if mine else "",
    }
    if lat is not None and lng is not None:
        out["distance_m"] = int(haversine_m(lat, lng, v["lat"], v["lng"]))
    return out

class VaultCreateReq(BaseModel):
    label: str = ""
    lat: float
    lng: float
    radius: int = 50
    zec: float
    message: str = ""
    opens_at: float          # unix seconds; the client converts from local time
    closes_at: float
    target_address: str = ""

class VaultClaimReq(BaseModel):
    lat: float
    lng: float
    accuracy: float = 0

@app.post("/api/geovault/create")
async def geovault_create(req: VaultCreateReq, session=Depends(get_session)):
    wn = session["wallet_name"]
    if not await ensure_escrow() or not _escrow_pay_addr():
        raise HTTPException(503, detail="Escrow is not available right now. Try again shortly")
    if not (-90 <= req.lat <= 90) or not (-180 <= req.lng <= 180):
        raise HTTPException(400, detail="Those coordinates are not on Earth")
    if not (5 <= req.radius <= MAX_RADIUS_M):
        raise HTTPException(400, detail=f"Radius must be between 5 and {MAX_RADIUS_M} meters")
    zats = int((Decimal(str(req.zec)) * 100_000_000).to_integral_value(rounding=ROUND_DOWN))
    if zats < VAULT_MIN_ZATS:
        raise HTTPException(400, detail=f"Minimum vault is {VAULT_MIN_ZATS / 1e8:.4f} ZEC")
    if zats > VAULT_MAX_ZATS:
        raise HTTPException(400, detail=f"Maximum vault is {VAULT_MAX_ZATS / 1e8:.4f} ZEC")
    now = time.time()
    if req.closes_at <= req.opens_at:
        raise HTTPException(400, detail="The window has to close after it opens")
    if req.closes_at <= now:
        raise HTTPException(400, detail="That window has already closed")
    if req.closes_at - req.opens_at > MAX_WINDOW_SEC:
        raise HTTPException(400, detail="A window can run for at most 90 days")
    if len(req.message or "") > MEMO_MAX:
        raise HTTPException(400, detail=f"Message must be under {MEMO_MAX} characters")
    creator_addr = _claim_addr(session)
    if not creator_addr:
        raise HTTPException(400, detail="Your wallet has no shielded address yet. Reopen it and try again")

    vid = secrets.token_hex(8)
    total = zats + PAYOUT_RESERVE
    # The ledger row is written BEFORE the money moves. If the process dies
    # mid-send, a "funding" row survives for the sweeper to match against the
    # chain; the reverse order would strand ZEC in escrow with no record of
    # whose it was. A row without a landed transfer dies as "unfunded" after
    # the grace period, so the early write costs nothing.
    async with geo_lock:
        vaults[vid] = {
            "id": vid, "creator_wn": wn, "creator_address": creator_addr,
            "label": (req.label or "Unnamed vault")[:60],
            "lat": req.lat, "lng": req.lng, "radius": int(req.radius),
            "zats": zats, "funded_zats": total,
            "message_enc": enc_msg(req.message or ""),
            "target_address": (req.target_address or "").strip(),
            "opens_at": float(req.opens_at), "closes_at": float(req.closes_at),
            "status": "funding", "fund_txid": "", "created": now,
            "claimed_wn": "", "claimed_address": "", "claim_txid": "", "claimed_at": 0,
            "attempts": [],
        }
        save_vaults()

    async def _drop_row():
        async with geo_lock:
            vaults.pop(vid, None)
            save_vaults()

    # Funding is a plain shielded send with a tag in the memo, so the sweeper can
    # match the arriving note to this vault. No app fee is charged on vaults.
    outputs = [{"address": _escrow_pay_addr(), "amount": total, "memo": f"zaim-vault:{vid}"}]
    try:
        result = await azec(wn, "quicksend", [json.dumps(outputs)])
    except HTTPException as e:
        if e.status_code == 504:
            # Timeout: the send may still have gone out. Keep the row; the
            # sweeper arms it if the transfer lands, or retires it unfunded.
            return {"vault": _vault_public(vaults[vid], wn), "funding_zec": total / 1e8,
                    "message": "The funding payment is taking longer than usual. "
                               "The vault arms by itself if it lands"}
        await _drop_row()
        detail = str(e.detail)
        if "insufficient" in detail.lower() or "funds" in detail.lower():
            raise HTTPException(400, detail=f"Not enough ZEC. A {zats / 1e8:.4f} ZEC vault costs "
                                            f"{total / 1e8:.4f} ZEC including the payout fee reserve")
        raise
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    # zingo-cli reports some failures (an empty wallet, for one) in its output
    # rather than in its exit code, so a 200 from the CLI is not proof of a send.
    # No txid, no vault: never keep an escrow row the chain will not back.
    fund_txid = _extract_txid(result)
    if not fund_txid:
        await _drop_row()
        raw = json.dumps(result, default=str).lower()
        print(f"[geovault] funding send produced no txid: {str(result)[:300]}", flush=True)
        if "insufficient" in raw or "not enough" in raw or "no funds" in raw:
            raise HTTPException(400, detail=f"Not enough ZEC. A {zats / 1e8:.4f} ZEC vault costs "
                                            f"{total / 1e8:.4f} ZEC including the payout fee reserve")
        if "scan blocks" in raw or "not synced" in raw or "syncing" in raw:
            raise HTTPException(409, detail="Your wallet is still syncing with the chain. "
                                            "Give it a minute and try again")
        raise HTTPException(502, detail="The escrow payment did not go through, so no vault was created. "
                                        "Nothing left your wallet")

    async with geo_lock:
        vaults[vid]["fund_txid"] = fund_txid
        save_vaults()
    asyncio.create_task(reconcile_vaults())
    return {"vault": _vault_public(vaults[vid], wn), "funding_zec": total / 1e8,
            "message": "Vault funded. It arms as soon as the escrow payment lands."}

@app.get("/api/geovault/mine")
async def geovault_mine(session=Depends(get_session)):
    wn = session["wallet_name"]
    me = _claim_addr(session)
    out = []
    for v in vaults.values():
        gated_to_me = v.get("target_address") and me and v["target_address"] == me
        if v.get("creator_wn") == wn or v.get("claimed_wn") == wn or gated_to_me:
            out.append(_vault_public(v, wn))
    out.sort(key=lambda r: r.get("created", 0), reverse=True)
    return {"vaults": out, "escrow_address": _escrow_pay_addr()}

@app.get("/api/geovault/nearby")
async def geovault_nearby(lat: float, lng: float, km: float = 50, session=Depends(get_session)):
    """Open drops within range. Gated vaults never appear here — they show up in
    /mine for the wallet they are addressed to. The radius is clamped: without
    the cap, one request with a huge km would dump the exact coordinates of
    every open vault in the world, and drop locations are only anyone's
    business locally."""
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise HTTPException(400, detail="Those coordinates are not on Earth")
    km = max(0.1, min(float(km), 50.0))
    wn = session["wallet_name"]
    now = time.time()
    out = []
    for v in vaults.values():
        if v["status"] != "armed" or v.get("target_address"):
            continue
        if v["closes_at"] <= now:
            continue
        d = haversine_m(lat, lng, v["lat"], v["lng"])
        if d <= km * 1000:
            out.append(_vault_public(v, wn, lat, lng))
    out.sort(key=lambda r: r.get("distance_m", 0))
    return {"vaults": out[:50]}

@app.get("/api/geovault/{vault_id}")
async def geovault_get(vault_id: str, session=Depends(get_session)):
    v = vaults.get(vault_id)
    if not v:
        raise HTTPException(404, detail="No vault with that id")
    # A gated vault's coordinates are nobody's business but the two wallets in it,
    # even for someone who guessed or was handed the id.
    if (v.get("target_address") and v["target_address"] != _claim_addr(session)
            and v.get("creator_wn") != session["wallet_name"]):
        raise HTTPException(404, detail="No vault with that id")
    return {"vault": _vault_public(v, session["wallet_name"])}

@app.post("/api/geovault/{vault_id}/claim")
async def geovault_claim(vault_id: str, req: VaultClaimReq, session=Depends(get_session)):
    """Every rule that matters is checked here, under the lock, before a single
    zatoshi moves. The client's job is only to report where it thinks it is."""
    wn = session["wallet_name"]
    to_addr = _claim_addr(session)
    if not to_addr:
        raise HTTPException(400, detail="Your wallet has no shielded address to pay out to")
    now = time.time()
    async with geo_lock:
        v = vaults.get(vault_id)
        if not v:
            raise HTTPException(404, detail="No vault with that id")
        if v["status"] == "claimed":
            raise HTTPException(409, detail="Someone already opened this vault")
        if v["status"] == "claiming":
            raise HTTPException(409, detail="A claim is already going through")
        if v["status"] == "funding":
            raise HTTPException(409, detail="This vault is still being funded")
        if v["status"] != "armed":
            raise HTTPException(409, detail=f"This vault is {v['status']}")
        if now < v["opens_at"]:
            raise HTTPException(403, detail="The window has not opened yet")
        if now > v["closes_at"]:
            raise HTTPException(403, detail="The window has closed")
        if v.get("creator_wn") == wn:
            raise HTTPException(403, detail="You cannot claim your own vault. Cancel it instead")
        if v.get("target_address") and v["target_address"] != to_addr:
            raise HTTPException(403, detail="This vault is addressed to a different wallet")
        acc = max(0.0, float(req.accuracy or 0))
        if acc > MAX_ACCURACY_M:
            raise HTTPException(400, detail=f"Your GPS fix is {int(acc)}m vague. Move somewhere with a clearer sky")
        dist = haversine_m(req.lat, req.lng, v["lat"], v["lng"])
        # Accuracy earns some slack, but never more than the radius itself:
        # otherwise a claimed 300m error would open a 50m vault from down the road.
        slack = min(acc, float(v["radius"]))
        v.setdefault("attempts", []).append({"wn": wn, "at": now, "dist": int(dist), "acc": int(acc)})
        v["attempts"] = v["attempts"][-20:]
        if dist > v["radius"] + slack:
            save_vaults()
            raise HTTPException(403, detail=f"You are {int(dist)}m away. This vault opens within {v['radius']}m")
        v["status"] = "claiming"
        v["claimed_wn"] = wn
        v["claimed_address"] = to_addr
        save_vaults()

    # Payout happens outside the lock: it talks to the chain and takes seconds.
    try:
        msg = dec_msg(v.get("message_enc", ""))
        memo = f"ZAIM vault: {v.get('label', '')}".strip()
        if msg:
            memo = (memo + "\n\n" + msg)[:MEMO_MAX + 60]
        await ensure_escrow()
        await azec(ESCROW_WN, "sync", ["run"])
        outputs = [{"address": to_addr, "amount": v["zats"], "memo": memo}]
        result = await azec(ESCROW_WN, "quicksend", [json.dumps(outputs)])
        await azec(ESCROW_WN, "save")
        txid = _extract_txid(result)
    except Exception as e:
        # A timeout is the one failure where the payment may still have gone out.
        # Retrying that would pay twice, so it parks in "review" for a human
        # instead of going back on the shelf.
        ambiguous = isinstance(e, HTTPException) and e.status_code == 504
        async with geo_lock:
            v["status"] = "review" if ambiguous else "armed"
            if not ambiguous:
                v["claimed_wn"] = ""
                v["claimed_address"] = ""
            save_vaults()
        print(f"[geovault] payout failed for {vault_id} (ambiguous={ambiguous}): {e}", flush=True)
        if ambiguous:
            raise HTTPException(504, detail="The payout timed out on the network. We are checking it, "
                                            "do not try again yet")
        raise HTTPException(502, detail="The payout did not go through. Nothing was taken from the vault, try again")
    if not txid:
        # Same reasoning: the send reported no failure and no txid, so we cannot
        # know whether it landed. Park it rather than risk a second payout.
        async with geo_lock:
            v["status"] = "review"
            save_vaults()
        print(f"[geovault] payout with no txid for {vault_id}: {str(result)[:300]}", flush=True)
        raise HTTPException(502, detail="The payout could not be confirmed. It is being checked, "
                                        "do not try again yet")
    async with geo_lock:
        v["status"] = "claimed"
        v["claim_txid"] = txid
        v["claimed_at"] = time.time()
        save_vaults()
    wallet_cache.pop(wn, None)
    return {"ok": True, "zec": v["zats"] / 1e8, "txid": txid, "message": msg,
            "vault": _vault_public(v, wn)}

@app.post("/api/geovault/{vault_id}/cancel")
async def geovault_cancel(vault_id: str, session=Depends(get_session)):
    """Creator pulls the vault back before anyone opens it. Same refund path the
    expiry sweeper uses."""
    wn = session["wallet_name"]
    async with geo_lock:
        v = vaults.get(vault_id)
        if not v or v.get("creator_wn") != wn:
            raise HTTPException(404, detail="No vault with that id")
        if v["status"] not in ("armed", "funding"):
            raise HTTPException(409, detail=f"This vault is {v['status']}")
        if v["status"] == "funding":
            raise HTTPException(409, detail="Wait for funding to land, then cancel")
        v["status"] = "refunding"
        save_vaults()
    ok = await _refund_vault(v, "cancelled")
    if not ok:
        raise HTTPException(502, detail="The refund did not go through. The vault is unchanged, try again")
    return {"ok": True, "vault": _vault_public(v, wn)}

async def _refund_vault(v, final_status):
    """Escrow -> creator. Used by cancel and by the expiry sweeper."""
    try:
        await ensure_escrow()
        await azec(ESCROW_WN, "sync", ["run"])
        outputs = [{"address": v["creator_address"], "amount": v["zats"],
                    "memo": f"ZAIM vault returned: {v.get('label', '')}".strip()[:MEMO_MAX]}]
        result = await azec(ESCROW_WN, "quicksend", [json.dumps(outputs)])
        await azec(ESCROW_WN, "save")
        txid = _extract_txid(result)
        if not txid:
            # Unconfirmable: park it. The sweeper runs every 90s and a blind
            # retry loop on an unconfirmable send is how escrow pays twice.
            async with geo_lock:
                v["status"] = "review"
                save_vaults()
            print(f"[geovault] refund with no txid for {v['id']}: {str(result)[:300]}", flush=True)
            return False
        async with geo_lock:
            v["status"] = final_status
            v["refund_txid"] = txid
            v["refunded_at"] = time.time()
            save_vaults()
        wallet_cache.pop(v.get("creator_wn", ""), None)
        return True
    except Exception as e:
        ambiguous = isinstance(e, HTTPException) and e.status_code == 504
        async with geo_lock:
            v["status"] = "review" if ambiguous else "armed"
            save_vaults()
        print(f"[geovault] refund failed for {v['id']} (ambiguous={ambiguous}): {e}", flush=True)
        return False

def _funding_landed(parsed, vid, need_zats):
    """True only if a single escrow transfer carries BOTH the vault's memo tag
    and at least the full funded amount. Matching the tag alone would let a
    dust transaction with a copied memo arm a vault escrow never received."""
    tag = f"zaim-vault:{vid}"
    for t in parsed:
        if not isinstance(t, dict):
            continue
        memos = t.get("memos") if isinstance(t.get("memos"), list) else []
        blob = " ".join(str(m) for m in memos) + " " + str(t.get("memo", ""))
        if tag not in blob:
            continue
        try:
            val = int(t.get("value", 0))
        except (TypeError, ValueError):
            val = 0
        if val >= need_zats:
            return True
        print(f"[geovault] tagged transfer for {vid} carries {val} < {need_zats} zats; ignoring", flush=True)
    return False

async def reconcile_vaults():
    """Arm funded vaults, refund expired ones. Funding is confirmed by finding
    the tagged, full-value transfer in the escrow wallet's own list, so a vault
    never arms on the strength of a send we merely attempted."""
    pending = [v for v in vaults.values() if v["status"] == "funding"]
    expired = [v for v in vaults.values()
               if v["status"] == "armed" and time.time() > v["closes_at"]]
    if not pending and not expired:
        return
    parsed = []
    if pending:
        try:
            await ensure_escrow()
            await azec(ESCROW_WN, "sync", ["run"])
            txs = await azec(ESCROW_WN, "value_transfers")
            parsed = txs if isinstance(txs, list) else parse_transactions(txs)
        except Exception as e:
            print(f"[geovault] escrow scan failed: {e}", flush=True)
        async with geo_lock:
            for v in pending:
                if _funding_landed(parsed, v["id"], v.get("funded_zats", v["zats"])):
                    v["status"] = "armed"
                    v["armed_at"] = time.time()
                elif time.time() - v.get("created", 0) > FUNDING_GRACE_SEC:
                    v["status"] = "unfunded"
            save_vaults()
    for v in expired:
        async with geo_lock:
            if v["status"] != "armed":
                continue
            v["status"] = "refunding"
            save_vaults()
        await _refund_vault(v, "expired")

async def periodic_vaults():
    while True:
        await asyncio.sleep(90)
        try:
            await reconcile_vaults()
        except Exception as e:
            print(f"[periodic_vaults] {e}", flush=True)

# ─── Admin ────────────────────────────────────────────────────────────────────
# There are no accounts to administer any more. Admin is ops only: wallet and
# session counts, and a force-seal for maintenance windows.

def get_admin(request: Request):
    if not ADMIN_PASSWORD:
        raise HTTPException(403, detail="Admin is disabled. Set ZAIM_ADMIN_PASSWORD to enable it")
    token = request.headers.get("X-Admin-Token", "")
    if not hmac.compare_digest(token, ADMIN_PASSWORD):
        raise HTTPException(403, detail="Admin access denied")
    return True

@app.get("/api/admin/geovaults")
async def admin_geovaults(admin=Depends(get_admin)):
    """Ops view of the vault ledger. Coordinates and amounts, never messages:
    the operator holding the at-rest key is no reason to put plaintext in a
    dashboard."""
    out = []
    for v in sorted(vaults.values(), key=lambda r: r.get("created", 0), reverse=True):
        out.append({
            "id": v["id"], "label": v.get("label", ""), "status": v["status"],
            "zec": v["zats"] / 1e8, "funded_zec": v.get("funded_zats", 0) / 1e8,
            "lat": v["lat"], "lng": v["lng"], "radius": v["radius"],
            "opens_at": v["opens_at"], "closes_at": v["closes_at"],
            "creator_wn": v.get("creator_wn", ""), "claimed_wn": v.get("claimed_wn", ""),
            "fund_txid": v.get("fund_txid", ""), "claim_txid": v.get("claim_txid", ""),
            "refund_txid": v.get("refund_txid", ""), "attempts": len(v.get("attempts", [])),
            "has_message": bool(v.get("message_enc")), "gated": bool(v.get("target_address")),
        })
    return {"geovaults": out}

@app.get("/api/admin/stats")
async def admin_stats(admin=Depends(get_admin)):
    active, sealed_n = [], 0
    for e in sorted(os.listdir(WDIR)):
        if e.startswith("_"):
            continue
        if os.path.isdir(os.path.join(WDIR, e)):
            active.append(e)
        elif e.endswith(".sealed"):
            sealed_n += 1
    swaps_open = sum(1 for r in swaps.values() if r.get("status") not in TERMINAL_SWAP_STATES)
    return {
        "wallets_active": active,
        "wallets_sealed": sealed_n,
        "active_sessions": len(sessions),
        "cached_wallets": len(wallet_cache),
        "swaps_total": len(swaps),
        "swaps_open": swaps_open,
    }

@app.get("/api/admin/sessions")
async def admin_sessions(admin=Depends(get_admin)):
    import datetime as _dt
    out = []
    for sid, sess in sessions.items():
        out.append({
            "session_id": sid[:8] + "...",
            "wallet_name": sess.get("wallet_name", ""),
            "created": _dt.datetime.utcfromtimestamp(sess.get("created", 0)).isoformat() if sess.get("created") else "",
        })
    return {"sessions": out}

@app.get("/api/admin/escrow")
async def admin_escrow(admin=Depends(get_admin)):
    """Escrow health. The seed is deliberately NOT served here: it is the only
    way to recover vault funds, and a header token is too thin a gate for it.
    Read it on the box instead, where it never crosses the network:

        docker exec -it zaim-api /app/zingo-cli \\
            --offline --data-dir /app/wallets/_escrow recovery_info

    Do that once, write it down offline, and never run it again."""
    await ensure_escrow()
    bal = {}
    try:
        bal = parse_balance(await azec(ESCROW_WN, "balance"))
    except Exception as e:
        bal = {"error": str(e)[:120]}
    by_status = {}
    owed = 0
    for v in vaults.values():
        by_status[v["status"]] = by_status.get(v["status"], 0) + 1
        if v["status"] in ("armed", "claiming", "refunding", "review"):
            owed += v["zats"]
    return {"address": _escrow_pay_addr(), "balance": bal, "vaults": by_status,
            "owed_zats": owed, "owed_zec": owed / 1e8}

@app.post("/api/admin/seal_all")
async def admin_seal_all(admin=Depends(get_admin)):
    """Force-seal every wallet with a known key and drop all sessions."""
    sealed, left = [], []
    for entry in list(os.listdir(WDIR)):
        if entry.startswith("_") or not os.path.isdir(os.path.join(WDIR, entry)):
            continue
        ok = seal_wallet(entry)
        (sealed if ok else left).append(entry)
    sessions.clear()
    save_sessions()
    return {"sealed": sealed, "left_plaintext": left}
