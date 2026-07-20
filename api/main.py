"""
ZAIM Backend API - FastAPI + zecwallet-cli v1.8 (Zcash Light Client)
v0.8.0 - Seed only. No usernames, no passwords, no accounts.

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
import os, json, time, uuid, hashlib, hmac, secrets, asyncio, subprocess, re
import tarfile, shutil, io
from decimal import Decimal, ROUND_DOWN
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CLI = os.getenv("ZECWALLET_CLI", "/app/zecwallet-cli")
SERVER = os.getenv("LIGHTWALLETD_SERVER", "https://lwdv3.zecwallet.co:443")
WDIR = os.getenv("WALLET_DIR", "/app/wallets")
SECRET = os.getenv("API_SECRET", "zaim-secret-prod")
ADMIN_PASSWORD = os.getenv("ZAIM_ADMIN_PASSWORD", "zaim-admin-2026")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS",
    "https://zaim.info,https://www.zaim.info,https://noscezaim.com,https://www.noscezaim.com",
).split(",") if o.strip()]
DUST = 10000
PBKDF2_ITER = 200_000

# ── App fee ───────────────────────────────────────────────────────────────────
# On each payment, a cut is routed to FEE_ADDRESS as a second output of the same
# shielded transaction (atomic — one tx, one network fee). Charged on TOP of the
# amount, so the recipient always gets exactly what the user entered.
# Dormant until FEE_ADDRESS is set: leave it empty and sends behave fee-free.
FEE_ADDRESS = os.getenv("FEE_ADDRESS", "")          # house z-address that collects fees
FEE_BPS = int(os.getenv("FEE_BPS", "0"))            # fee in basis points (100 = 1.00%)
FEE_MIN_ZATS = int(os.getenv("FEE_MIN_ZATS", "0"))  # optional floor, in zatoshis

def _warn_default_secret(name, value, default):
    if value == default:
        print(f"[SECURITY] {name} is using the built-in default — set it via env in production.", flush=True)

_warn_default_secret("API_SECRET", SECRET, "zaim-secret-prod")
_warn_default_secret("ZAIM_ADMIN_PASSWORD", ADMIN_PASSWORD, "zaim-admin-2026")

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
        raise HTTPException(400, detail="that does not look like a seed phrase (12 to 24 words)")
    return " ".join(words)

def seed_fingerprint(norm_seed):
    return hashlib.sha256(("zaim-fp-v1:" + norm_seed).encode()).hexdigest()[:16]

def seed_key(norm_seed, fp):
    return hashlib.pbkdf2_hmac("sha256", norm_seed.encode(), ("zaim-seal-v1:" + fp).encode(), PBKDF2_ITER)

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
        raise HTTPException(500, detail="sealed wallet failed to open. the seed derives the key, so this should not happen")
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
                if not os.path.isdir(wdir) or not entry.startswith("zw_"):
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

def wallet_env(wallet_name):
    """Isolate each user's wallet: zecwallet-cli reads/writes ~/.zcash relative
    to $HOME, so a per-wallet HOME gives every user a private wallet file.
    Without this, every user shares one wallet (same seed, same funds)."""
    wdir = os.path.join(WDIR, wallet_name)
    os.makedirs(wdir, exist_ok=True)
    env = dict(os.environ)
    env["HOME"] = wdir
    return wdir, env

def zec(wallet_name, command, args=None):
    wdir, env = wallet_env(wallet_name)
    cmd = [CLI, "--server", SERVER, command]
    if args:
        cmd.extend([str(a) for a in args])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env)
        out = r.stdout.strip()
        if r.returncode != 0:
            err = r.stderr.strip() or out
            raise HTTPException(500, detail="cli error: " + err)
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return {"raw": out}
    except subprocess.TimeoutExpired:
        raise HTTPException(504, detail="Timeout")
    except FileNotFoundError:
        raise HTTPException(503, detail="CLI not found")

wallet_locks = {}

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
        if wn.startswith("zw_") and not os.path.isdir(os.path.join(WDIR, wn)):
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

def extract_addrs(addr_result):
    z_addr = ""
    t_addr = ""
    ua_addr = ""
    if isinstance(addr_result, dict):
        ua_list = addr_result.get("ua_addresses", [])
        z_list = addr_result.get("z_addresses", [])
        t_list = addr_result.get("t_addresses", [])
        ua_addr = ua_list[0] if ua_list else ""
        z_addr = z_list[0] if z_list else ua_addr
        t_addr = t_list[0] if t_list else ""
    elif isinstance(addr_result, list):
        for a in addr_result:
            if isinstance(a, dict):
                ua_addr = a.get("encoded_address", a.get("address", ""))
                rec = a.get("receivers", {})
                if rec:
                    t_addr = rec.get("transparent", "")
                    z_addr = rec.get("sapling", "")
                if not z_addr:
                    z_addr = ua_addr
                break
    return z_addr, t_addr, ua_addr

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
        txs = await azec(wallet_name, "transactions")
        parsed_txs = parse_transactions(txs)
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
            await azec(wallet_name, "shield")
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
    sync_task = asyncio.create_task(periodic_sync())
    startup_task = asyncio.create_task(startup_sync())
    price_task = asyncio.create_task(periodic_price())
    seal_task = asyncio.create_task(periodic_seal())
    yield
    sync_task.cancel()
    startup_task.cancel()
    price_task.cancel()
    seal_task.cancel()

app = FastAPI(title="ZAIM API", version="0.7.0", lifespan=lifespan)
# The SPA is served same-origin (nginx proxies /api), so CORS is belt-and-braces.
# Restrict to the known origins; Bearer tokens are used (no cookies), so credentials are off.
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

class OpenReq(BaseModel):
    seed_phrase: str
    birthday: int = 0

class SendReq(BaseModel):
    to_address: str
    amount: float
    memo: Optional[str] = ""

class MsgReq(BaseModel):
    to_address: str
    message: str

def get_session(request: Request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if token not in sessions:
        raise HTTPException(401, detail="Not authenticated")
    s = sessions[token]
    wn = s.get("wallet_name", "")
    if wn:
        wdir, sealed = _wallet_paths(wn)
        # A sealed wallet cannot serve requests: the key died with the last
        # active period (idle seal or restart). The seed must be entered again.
        if not os.path.isdir(wdir) and os.path.exists(sealed):
            raise HTTPException(401, detail="wallet is sealed. enter your seed to unlock it")
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
    return {"status": "ok" if cli_ok else "degraded", "backend": "zecwallet-cli v1.8 (light client)",
            "server": SERVER, "cli_available": cli_ok, "wallets_active": active,
            "wallets_sealed": sealed, "wallets": active + sealed, "sessions": len(sessions)}

async def _read_addresses(wn):
    z_addr = t_addr = ua_addr = ""
    for _ in range(3):
        try:
            addr_result = await azec(wn, "addresses")
            t_result = await azec(wn, "t_addresses")
            z_addr, t_addr, ua_addr = extract_addrs(addr_result)
            if not t_addr:
                t_addr = extract_t_addr(t_result)
            if z_addr and t_addr:
                break
        except Exception:
            pass
        await asyncio.sleep(2)
    return z_addr, t_addr, ua_addr

def _new_session(wn, z_addr, t_addr, ua_addr):
    token = str(uuid.uuid4())
    sessions[token] = {"wallet_name": wn, "created": time.time(),
                       "z_address": z_addr, "t_address": t_addr, "ua_address": ua_addr}
    wallet_activity[wn] = time.time()
    save_sessions()
    return token

@app.post("/api/wallet/create")
async def create_wallet():
    """Make a brand new wallet. Returns the seed exactly once. The seed IS the
    account: fingerprint names the wallet dir, seed derives the sealing key."""
    tmp_wn = "new_" + secrets.token_hex(8)
    await azec(tmp_wn, "sync", ["run"])
    await asyncio.sleep(3)
    seed_result = await azec(tmp_wn, "seed")
    seed_text, birthday = "", 0
    if isinstance(seed_result, dict):
        seed_text = seed_result.get("seed", "")
        birthday = seed_result.get("birthday", 0)
    if not seed_text:
        shutil.rmtree(os.path.join(WDIR, tmp_wn), ignore_errors=True)
        raise HTTPException(500, detail="wallet creation failed, no seed produced")
    norm = normalize_seed(seed_text)
    fp = seed_fingerprint(norm)
    wn = "zw_" + fp
    wdir, _ = _wallet_paths(wn)
    if os.path.isdir(wdir) or os.path.exists(_wallet_paths(wn)[1]):
        shutil.rmtree(os.path.join(WDIR, tmp_wn), ignore_errors=True)
        raise HTTPException(500, detail="wallet collision, try again")
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

@app.post("/api/wallet/open")
async def open_wallet(req: OpenReq):
    """Sign in with a seed. Unseals the cached wallet if we have it, otherwise
    restores from the chain. Same seed, same wallet, any device."""
    norm = normalize_seed(req.seed_phrase)
    fp = seed_fingerprint(norm)
    wn = "zw_" + fp
    key = seed_key(norm, fp)
    wdir, sealed = _wallet_paths(wn)
    loop = asyncio.get_event_loop()
    restored = False
    if not os.path.isdir(wdir):
        if os.path.exists(sealed):
            await loop.run_in_executor(None, unseal_wallet, wn, key)
        else:
            # Fresh restore from seed. The seed goes to the CLI process only.
            _, env = wallet_env(wn)
            restore_cmd = [CLI, "--server", SERVER, "--seed", norm]
            if req.birthday > 0:
                restore_cmd += ["--birthday", str(req.birthday)]
            restore_cmd += ["sync", "run"]
            try:
                r = await loop.run_in_executor(None, lambda: subprocess.run(
                    restore_cmd, capture_output=True, text=True, timeout=600, env=env))
                if r.returncode != 0 and "error" in (r.stderr + r.stdout).lower():
                    shutil.rmtree(wdir, ignore_errors=True)
                    raise HTTPException(500, detail="restore failed: " + (r.stderr or r.stdout)[:160])
            except subprocess.TimeoutExpired:
                pass  # long rescan; wallet exists, sync continues in the background
            restored = True
    wallet_keys[wn] = key
    try:
        await azec(wn, "save")
    except Exception:
        pass
    z_addr, t_addr, ua_addr = await _read_addresses(wn)
    token = _new_session(wn, z_addr, t_addr, ua_addr)
    asyncio.create_task(sync_and_cache(wn))
    return {"token": token, "address": z_addr, "t_address": t_addr,
            "restored": restored,
            "message": "syncing from the chain, balances may take a few minutes" if restored else "unlocked"}

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
    result = await azec(wn, "send", [json.dumps(outputs)])
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    return {"result": result, "to": req.to_address, "amount": req.amount, "zatoshis": zatoshis,
            "fee_zatoshis": fee_zats, "fee_zec": fee_zats / 1e8}

@app.post("/api/message/send")
async def send_message(req: MsgReq, session=Depends(get_session)):
    wn = session["wallet_name"]
    outputs = [{"address": req.to_address, "amount": DUST, "memo": req.message}]
    result = await azec(wn, "send", [json.dumps(outputs)])
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    return {"result": result, "to": req.to_address, "message_preview": req.message[:50]}

@app.get("/api/messages")
async def get_messages(session=Depends(get_session)):
    wn = session["wallet_name"]
    try:
        txs = await azec(wn, "transactions")
        parsed = parse_transactions(txs)
        messages = []
        for tx in parsed:
            memo = tx.get("memo")
            if memo:
                messages.append({
                    "memo": memo,
                    "txid": tx.get("txid", ""),
                    "datetime": tx.get("datetime", ""),
                    "height": tx.get("blockheight", ""),
                    "amount": (tx.get("value", 0) / 1e8) if isinstance(tx.get("value"), int) else 0,
                    "sent": tx.get("kind", "") in ("send", "send-to-self"),
                })
        return {"messages": messages, "count": len(messages)}
    except Exception:
        return {"messages": [], "count": 0}

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
        txs = await azec(wn, "transactions")
        parsed = parse_transactions(txs)
        wallet_cache.setdefault(wn, {})["transactions"] = parsed
        return {"transactions": parsed}
    except Exception:
        return {"transactions": []}

@app.get("/api/wallet/seed")
async def get_seed(session=Depends(get_session)):
    result = await azec(session["wallet_name"], "seed")
    if isinstance(result, dict):
        seed_text = result.get("seed", "")
        birthday = result.get("birthday", 0)
        return {"seed": seed_text, "birthday": birthday}
    return result

@app.get("/api/node/info")
async def node_info():
    return {"server": SERVER, "backend": "zecwallet-cli v1.8", "synced": True}

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
        raise HTTPException(502, detail=f"swap service {e.code}: {msg or 'request rejected'}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=f"swap service unreachable: {e}")

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
        raise HTTPException(400, detail="direction must be buy or sell")
    asset = SWAP_ASSETS.get(req.asset)
    if not asset:
        raise HTTPException(400, detail="unknown asset")
    t_addr = session.get("t_address", "")
    if not t_addr:
        _, t_addr, _ = await _read_addresses(session["wallet_name"])
        if t_addr:
            session["t_address"] = t_addr
            save_sessions()
    if not t_addr:
        raise HTTPException(400, detail="wallet has no transparent address yet. try again in a minute")

    from datetime import timedelta, timezone as _tz
    deadline = (datetime.now(_tz.utc) + timedelta(minutes=SWAP_DEADLINE_MIN)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    if req.direction == "buy":
        # ZEC lands at the user's transparent address; refunds go back to the
        # external wallet the user pays from.
        if not req.refund_address or not SWAP_ADDR_RE.match(req.refund_address):
            raise HTTPException(400, detail="refund address on the origin chain is required")
        origin, dest = asset, ZEC_ASSET
        recipient, refund_to = t_addr, req.refund_address
    else:
        # ZEC leaves the user's wallet; refunds (if the swap dies) come back to
        # their own transparent address.
        if not req.recipient_address or not SWAP_ADDR_RE.match(req.recipient_address):
            raise HTTPException(400, detail="destination address is required")
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
        raise HTTPException(502, detail="swap service returned no deposit address")
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
        raise HTTPException(404, detail="swap not found")
    if rec.get("direction") != "sell":
        raise HTTPException(400, detail="only sell swaps execute on the server")
    if rec.get("status") != "READY_TO_SEND":
        raise HTTPException(409, detail=f"swap is {rec.get('status')}")
    if rec.get("deposit_memo"):
        raise HTTPException(400, detail="memo deposits are not supported for ZEC")
    dl = (rec.get("quote") or {}).get("deadline", "")
    try:
        dl_ts = datetime.fromisoformat(dl.replace("Z", "+00:00")).timestamp()
    except Exception:
        dl_ts = 0
    if dl_ts and dl_ts - time.time() < 60:
        rec["status"] = "EXPIRED"
        rec["updated"] = time.time()
        save_swaps()
        raise HTTPException(409, detail="quote expired. get a fresh one")

    wn = session["wallet_name"]
    zats = int(rec["amount_units"])
    outputs = [{"address": rec["deposit_address"], "amount": zats}]
    result = await azec(wn, "send", [json.dumps(outputs)])
    await azec(wn, "save")
    wallet_cache.pop(wn, None)
    txid = ""
    err_text = ""
    if isinstance(result, dict):
        txid = str(result.get("txid", "") or "")
        raw = str(result.get("raw", "") or result.get("error", "") or "")
        if not txid and raw:
            m = re.search(r'"txid"\s*:\s*"([0-9a-fA-F]{32,64})"', raw)
            txid = m.group(1) if m else ""
            if not txid:
                err_text = raw[:200]
    if not re.fullmatch(r"[0-9a-fA-F]{32,64}", txid):
        # zecwallet-cli exits 0 on some failures (e.g. insufficient funds) and
        # only reports the problem in its output. No txid means NOTHING was
        # broadcast — refuse loudly and keep the swap READY_TO_SEND so a
        # funded retry can still use it. Never record a send that didn't
        # happen (the MAXPAIN phantom-close lesson).
        raise HTTPException(400, detail="send failed, nothing broadcast: "
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
        raise HTTPException(404, detail="swap not found")
    if rec.get("status") in TERMINAL_SWAP_STATES:
        return {"swap": rec}
    if rec.get("direction") == "sell":
        if rec.get("status") != "READY_TO_SEND":
            raise HTTPException(409, detail=f"cannot cancel while {rec.get('status')}")
    else:
        if rec.get("status") not in ("AWAITING_DEPOSIT", "PENDING_DEPOSIT"):
            raise HTTPException(409, detail=f"cannot cancel while {rec.get('status')}")
        # Live check upstream: if a deposit was already seen, it is too late.
        try:
            st = await aintents("/v0/status", params={"depositAddress": rec["deposit_address"]})
            remote = st.get("status", "")
            if remote and remote != "PENDING_DEPOSIT":
                rec["status"] = remote
                rec["updated"] = time.time()
                save_swaps()
                raise HTTPException(409, detail="a deposit was already detected. the swap will complete or refund on its own")
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
        raise HTTPException(404, detail="swap not found")
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

# ─── Admin ────────────────────────────────────────────────────────────────────
# There are no accounts to administer any more. Admin is ops only: wallet and
# session counts, and a force-seal for maintenance windows.

def get_admin(request: Request):
    token = request.headers.get("X-Admin-Token", "")
    if not hmac.compare_digest(token, ADMIN_PASSWORD):
        raise HTTPException(403, detail="Admin access denied")
    return True

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
