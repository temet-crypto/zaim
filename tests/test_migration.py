"""Ironwood migration endpoints, with zingo stubbed at azec.

What these pin down: consent binds to the exact plan hash, the immediate path
never reports a send it cannot prove, a view-key session cannot migrate someone
else's seed, and the driver only ever does the step the phase calls for."""
import asyncio
import os
import tempfile

import pytest
from fastapi import HTTPException

os.environ.setdefault("WALLET_DIR", tempfile.mkdtemp(prefix="zaim-mig-"))
os.environ.setdefault("ZCASH_CHAIN", "mainnet")

import api.main as m  # noqa: E402

HASH = "ab" * 32


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def zingo(monkeypatch):
    """Scripted azec: records every call, answers from a table."""
    calls = []
    answers = {
        ("balance",): {"confirmed_orchard_balance": 5_000_000, "total_orchard_balance": 5_000_000,
                       "confirmed_ironwood_balance": 0},
        ("migration", "plan"): {"split_rounds": 1, "split_transactions": 2, "split_fee": 20_000,
                                "parts": [1_000_000, 1_000_000, 2_000_000], "residual": 7_000,
                                "plan_hash": HASH},
        ("drain", "plan"): {"transactions": 1, "migrated": 4_980_000, "fee": 10_000, "residual": 10_000},
        ("drain", "now"): {"txids": ["f" * 64], "migrated": 4_980_000, "fee": 10_000, "residual": 10_000},
        ("migration", "status"): {"phase": "note splitting (round 1)", "parts_total": 3,
                                  "parts_confirmed": 0, "value_total": 4_000_000, "value_migrated": 0,
                                  "upcoming_windows": [], "due_now": None},
    }

    async def fake(wn, cmd, args=None):
        key = (cmd,) + tuple(args or [])[:1]
        calls.append((wn, cmd) + tuple(args or []))
        if key in answers:
            v = answers[key]
            if isinstance(v, Exception):
                raise v
            return v
        return {"raw": "ok"}

    monkeypatch.setattr(m, "azec", fake)
    monkeypatch.setattr(m, "ZINGO_SESSIONS", True)
    return calls, answers


def seed_session(wn="zw_0123456789abcdef"):
    os.makedirs(os.path.join(m.WDIR, wn), exist_ok=True)
    return {"wallet_name": wn}


class TestPlan:
    def test_private_plan_reports_transfers_fees_and_stranded(self, zingo):
        p = run(m.migration_plan(m.MigrationReq(mode="private"), seed_session()))
        assert p["plan_hash"] == HASH
        assert p["transfers"] == 3
        assert p["migrated_zats"] == 4_000_000
        assert p["fee_zats"] == 20_000 + 3 * m.PART_FEE_ZATS
        assert p["stranded_zats"] == 7_000

    def test_immediate_plan_sends_nothing(self, zingo):
        calls, _ = zingo
        p = run(m.migration_plan(m.MigrationReq(mode="immediate"), seed_session()))
        assert p["transfers"] == 1 and p["migrated_zats"] == 4_980_000
        assert not any(c[1] == "drain" and c[2] == "now" for c in calls)


class TestStart:
    def test_private_start_needs_the_reviewed_hash(self, zingo):
        with pytest.raises(HTTPException) as e:
            run(m.migration_start(m.MigrationReq(mode="private", plan_hash=""), seed_session()))
        assert e.value.status_code == 400

    def test_private_start_passes_the_hash_and_records_the_marker(self, zingo, monkeypatch):
        calls, _ = zingo
        started = []
        monkeypatch.setattr(m, "_drive_migration", lambda wn: started.append(wn) or asyncio.sleep(0))
        s = seed_session("zw_1111111111111111")
        run(m.migration_start(m.MigrationReq(mode="private", plan_hash=HASH), s))
        assert ("zw_1111111111111111", "migration", "start", HASH) in calls
        assert m._read_marker("zw_1111111111111111")["mode"] == "private"

    def test_immediate_without_a_txid_is_outcome_unknown_not_success(self, zingo):
        _, answers = zingo
        answers[("drain", "now")] = {"raw": "something unexpected"}
        with pytest.raises(HTTPException) as e:
            run(m.migration_start(m.MigrationReq(mode="immediate"), seed_session()))
        assert e.value.status_code == 502

    def test_immediate_returns_the_txids(self, zingo):
        r = run(m.migration_start(m.MigrationReq(mode="immediate"), seed_session()))
        assert r["txids"] == ["f" * 64]


class TestViewKeySessions:
    def test_a_view_session_needs_the_seed_to_migrate(self, zingo):
        with pytest.raises(HTTPException) as e:
            run(m.migration_plan(m.MigrationReq(mode="private"), {"wallet_name": "zv_aaaaaaaaaaaaaaaa"}))
        assert e.value.status_code == 400

    def test_a_view_session_cannot_migrate_a_different_seed(self, zingo):
        s = {"wallet_name": "zv_aaaaaaaaaaaaaaaa", "spend_wallet": "zw_ffffffffffffffff"}
        seed = " ".join(["abandon"] * 23 + ["art"])
        with pytest.raises(HTTPException) as e:
            run(m.migration_plan(m.MigrationReq(mode="private", seed_phrase=seed), s))
        assert e.value.status_code == 403


class TestDriver:
    def _mark(self, wn):
        os.makedirs(os.path.join(m.WDIR, wn), exist_ok=True)
        m._write_marker(wn, {"mode": "private"})

    def test_splitting_phase_continues(self, zingo):
        calls, _ = zingo
        self._mark("zw_2222222222222222")
        run(m._drive_migration("zw_2222222222222222"))
        assert ("zw_2222222222222222", "migration", "continue") in calls
        assert not any(c[1:3] == ("migration", "auto") for c in calls)

    def test_scheduled_phase_sends_what_is_due(self, zingo):
        calls, answers = zingo
        answers[("migration", "status")] = {"phase": "parts scheduled"}
        self._mark("zw_3333333333333333")
        run(m._drive_migration("zw_3333333333333333"))
        assert ("zw_3333333333333333", "migration", "auto") in calls

    def test_complete_clears_the_marker_and_sends_nothing(self, zingo):
        calls, answers = zingo
        answers[("migration", "status")] = {"phase": "complete (7000 zatoshis residual)"}
        self._mark("zw_4444444444444444")
        run(m._drive_migration("zw_4444444444444444"))
        assert m._read_marker("zw_4444444444444444") is None
        assert not any(c[1:3] in (("migration", "auto"), ("migration", "continue")) for c in calls)

    def test_no_marker_no_action(self, zingo):
        calls, _ = zingo
        os.makedirs(os.path.join(m.WDIR, "zw_5555555555555555"), exist_ok=True)
        run(m._drive_migration("zw_5555555555555555"))
        assert calls == []


class TestStatus:
    def test_reports_need_from_the_orchard_balance(self, zingo):
        st = run(m.migration_status(seed_session("zw_6666666666666666")))
        assert st["needed"] is True and st["orchard_zats"] == 5_000_000
        assert st["active"] is False

    def test_dust_in_orchard_is_not_worth_migrating(self, zingo):
        _, answers = zingo
        answers[("balance",)] = {"total_orchard_balance": 15_000}
        st = run(m.migration_status(seed_session("zw_7777777777777777")))
        assert st["needed"] is False
