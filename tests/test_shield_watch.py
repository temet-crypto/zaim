"""ZAIM Swap handoff: the watch that keeps a wallet awake until a swap payout
lands on its t-address and has been shielded.

What these pin down: the handoff only works for a wallet that can spend, the
address goes out in a URL fragment, the watch keeps the wallet in use while it
waits, and it ends on shield, on timeout, or when the wallet seals."""
import asyncio
import os
import tempfile

import pytest
from fastapi import HTTPException

os.environ.setdefault("WALLET_DIR", tempfile.mkdtemp(prefix="zaim-watch-"))
os.environ.setdefault("ZCASH_CHAIN", "mainnet")

import api.main as m  # noqa: E402

T1 = "t1Hxw6JqWMnhDK5jRCieg5bFHM2qt7UtQvu"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    m.shield_watch.clear()
    m.wallet_cache.clear()
    monkeypatch.setattr(m, "save_sessions", lambda: None)
    yield
    m.shield_watch.clear()


def wallet(wn="zw_0123456789abcdef", t=0):
    os.makedirs(os.path.join(m.WDIR, wn), exist_ok=True)
    m.wallet_cache[wn] = {"balance": {"transparent_balance": t}}
    return {"wallet_name": wn, "t_address": T1}


def test_handoff_returns_fragment_url_and_starts_watch():
    s = wallet()
    r = run(m.swap_handoff(session=s))
    assert r["t_address"] == T1
    assert r["url"] == f"{m.SWAP_SITE}/#get=ZEC&addr={T1}&zaim=1"
    assert "?" not in r["url"]                       # never in a query string
    w = m.shield_watch[s["wallet_name"]]
    assert w["seen"] is False and w["until"] > m.time.time()


def test_view_only_cannot_hand_off():
    s = wallet("zv_0123456789abcdef")
    with pytest.raises(HTTPException) as e:
        run(m.swap_handoff(session=s))
    assert e.value.status_code == 400
    s = wallet()
    s["view_only"] = True
    with pytest.raises(HTTPException):
        run(m.swap_handoff(session=s))
    assert not m.shield_watch


def test_watch_keeps_wallet_in_use_until_payout_is_shielded():
    s = wallet()
    wn = s["wallet_name"]
    run(m.swap_handoff(session=s))
    now = m.time.time() + 600
    assert m.shield_watch_tick(now) == {wn}         # nothing yet: still waiting
    assert m.wallet_activity[wn] == now             # and counted as in use
    m.wallet_cache[wn]["balance"]["transparent_balance"] = 5_000_000   # payout lands
    assert m.shield_watch_tick(now + 60) == {wn}
    assert m.shield_watch[wn]["seen"] is True
    m.wallet_cache[wn]["balance"]["transparent_balance"] = 0           # auto_shield ran
    assert m.shield_watch_tick(now + 120) == set()


def test_dust_below_floor_does_not_count_as_payout():
    s = wallet(t=5_000)
    wn = s["wallet_name"]
    run(m.swap_handoff(session=s))
    assert m.shield_watch_tick(m.time.time() + 60) == {wn}
    assert m.shield_watch[wn]["seen"] is False


def test_watch_times_out():
    s = wallet()
    run(m.swap_handoff(session=s))
    late = m.time.time() + m.SHIELD_WATCH_MIN * 60 + 1
    assert m.shield_watch_tick(late) == set()


def test_watch_ends_when_wallet_seals():
    s = wallet("zw_feedfacecafebeef")
    run(m.swap_handoff(session=s))
    os.rmdir(os.path.join(m.WDIR, s["wallet_name"]))   # sealed: the plaintext dir is gone
    assert m.shield_watch_tick(m.time.time() + 60) == set()


def test_watch_survives_restart(tmp_path, monkeypatch):
    f = tmp_path / "w.json"
    monkeypatch.setattr(m, "SHIELD_WATCH_FILE", str(f))
    s = wallet()
    run(m.swap_handoff(session=s))
    saved = dict(m.shield_watch)
    m.shield_watch.clear()
    m.load_shield_watch()
    assert m.shield_watch == saved


def test_balance_reports_watch():
    s = wallet(t=0)
    wn = s["wallet_name"]
    m.wallet_cache[wn]["last_sync"] = m.time.time()
    assert run(m.get_balance(session=s))["swap_watch"] is False
    run(m.swap_handoff(session=s))
    assert run(m.get_balance(session=s))["swap_watch"] is True
