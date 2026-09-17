"""The inscriptions proxy: gating, fee math, and the order money moves in.

The mint itself is proven in zord-carrier against a real chain. What is worth
pinning here is ZAIM's half — that the feature stays off unless fully
configured, that our fee is added to the chain cost rather than replacing it,
that a mint is never charged for before it exists, and that the sidecar's
user-facing errors reach the user instead of becoming a bare 500.
"""

import asyncio
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

os.environ.setdefault("WALLET_DIR", tempfile.mkdtemp(prefix="zaim-insc-"))
os.environ.setdefault("ZCASH_CHAIN", "mainnet")

import api.main as m  # noqa: E402


class StubSidecar(BaseHTTPRequestHandler):
    """Stands in for zord-carrier. Records what it was asked for."""

    quote = {"totalSpend": "25000", "inscriptionId": "abc123i0"}
    mint = {"inscriptionId": "abc123i0", "commitTxid": "c0ffee", "revealTxid": "deadbeef"}
    fail_with = None          # (status, error) to return instead
    seen = []

    def _reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        StubSidecar.seen.append((self.path, body, self.headers.get("Authorization")))
        if StubSidecar.fail_with:
            code, err = StubSidecar.fail_with
            return self._reply(code, {"error": err})
        self._reply(200, StubSidecar.quote if self.path == "/quote" else StubSidecar.mint)

    def do_GET(self):
        StubSidecar.seen.append((self.path, None, self.headers.get("Authorization")))
        if self.path.startswith("/owned"):
            return self._reply(200, {"address": "tm1", "count": 0, "inscriptions": []})
        self._reply(200, {"network": "testnet", "broadcastEnabled": False, "indexedTo": 99})

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def sidecar():
    srv = HTTPServer(("127.0.0.1", 0), StubSidecar)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture(autouse=True)
def configured(sidecar, monkeypatch):
    monkeypatch.setattr(m, "ZORD_URL", sidecar)
    monkeypatch.setattr(m, "ZORD_TOKEN", "stub-token")
    monkeypatch.setattr(m, "TREASURY_ADDRESS", "u1treasury")
    monkeypatch.setattr(m, "INSCRIPTION_FEE_USD", 1.0)
    monkeypatch.setattr(m, "_fetch_zec_price", lambda: (50.0, 0.0))  # 1 USD = 2_000_000 zats
    StubSidecar.fail_with = None
    StubSidecar.seen.clear()
    yield


SESSION = {"wallet_name": "zw_test", "t_address": "tm1dest", "z_address": "zs1self"}


def run(coro):
    return asyncio.run(coro)


class TestGating:
    def test_off_when_no_url(self, monkeypatch):
        monkeypatch.setattr(m, "ZORD_URL", "")
        with pytest.raises(m.HTTPException):
            m._require_inscriptions()

    def test_off_when_no_token(self, monkeypatch):
        monkeypatch.setattr(m, "ZORD_TOKEN", "")
        with pytest.raises(m.HTTPException):
            m._require_inscriptions()

    def test_off_when_there_is_nowhere_to_bill(self, monkeypatch):
        # Minting bills after broadcasting, so an unset treasury would make
        # every mint free and the loss would only appear in the logs.
        monkeypatch.setattr(m, "TREASURY_ADDRESS", "")
        with pytest.raises(m.HTTPException):
            m._require_inscriptions()

    def test_status_reports_disabled_rather_than_erroring(self, monkeypatch):
        monkeypatch.setattr(m, "ZORD_URL", "")
        assert run(m.inscriptions_status(SESSION)) == {"enabled": False}


class TestBodyMapping:
    def test_maps_snake_case_to_the_sidecar_spelling(self):
        body = m._zord_body(m.InscribeReq(kind="artifact", content_type="image/png",
                                          content_base64="aGk="), "tm1dest")
        assert body == {"kind": "artifact", "destination": "tm1dest",
                        "contentType": "image/png", "contentBase64": "aGk="}

    def test_omits_fields_that_were_not_set(self):
        body = m._zord_body(m.InscribeReq(kind="text", text="hello"), "tm1dest")
        assert body == {"kind": "text", "destination": "tm1dest", "text": "hello"}
        assert "contentType" not in body

    def test_carries_collection_fields_for_a_deploy(self):
        body = m._zord_body(m.InscribeReq(kind="deploy", collection="zaim", supply=100,
                                          meta_cid="Qm1", royalty_bps=250), "tm1dest")
        assert body["collection"] == "zaim" and body["supply"] == 100
        assert body["metaCid"] == "Qm1" and body["royaltyBps"] == 250

    def test_never_forwards_the_seed(self):
        # The seed is for paying us, not for the sidecar, which has no business
        # seeing it and no use for it.
        body = m._zord_body(m.InscribeReq(kind="text", text="hi", seed_phrase="abandon " * 24), "tm1dest")
        assert "seed_phrase" not in body and "seedPhrase" not in body


class TestQuote:
    def test_adds_our_fee_on_top_of_the_chain_cost(self):
        q = run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert q["chain_zats"] == 25_000          # from the sidecar
        assert q["fee_zats"] == 2_000_000         # 1 USD at 50 USD/ZEC
        assert q["total_zats"] == 2_025_000
        assert q["total_zec"] == pytest.approx(0.02025)

    def test_quotes_the_chain_cost_alone_when_we_charge_nothing(self, monkeypatch):
        monkeypatch.setattr(m, "INSCRIPTION_FEE_USD", 0.0)
        q = run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert q["fee_zats"] == 0 and q["total_zats"] == 25_000

    def test_sends_the_bearer_token(self):
        run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert StubSidecar.seen[-1][2] == "Bearer stub-token"

    def test_destination_is_the_users_own_address(self):
        run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert StubSidecar.seen[-1][1]["destination"] == "tm1dest"

    def test_refuses_a_wallet_with_no_transparent_address(self):
        with pytest.raises(m.HTTPException) as e:
            run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"),
                                     {"wallet_name": "zw_t", "t_address": ""}))
        assert "transparent" in e.value.detail

    def test_refuses_when_the_price_feed_is_down(self, monkeypatch):
        def broken():
            raise RuntimeError("no price")
        monkeypatch.setattr(m, "_fetch_zec_price", broken)
        with pytest.raises(m.HTTPException) as e:
            run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert e.value.status_code == 503


class TestSidecarErrors:
    def test_passes_a_user_facing_error_through(self):
        # "too large, put it on IPFS" is advice; turning it into a 500 would
        # throw away the only part the user can act on.
        StubSidecar.fail_with = (413, "content is 20000 bytes; put the media on IPFS")
        with pytest.raises(m.HTTPException) as e:
            run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert e.value.status_code == 413
        assert "IPFS" in e.value.detail

    def test_reports_a_sidecar_crash_as_a_gateway_error(self):
        StubSidecar.fail_with = (500, "")
        with pytest.raises(m.HTTPException) as e:
            run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert e.value.status_code == 502

    def test_reports_an_unreachable_sidecar_as_unavailable(self, monkeypatch):
        monkeypatch.setattr(m, "ZORD_URL", "http://127.0.0.1:1")
        with pytest.raises(m.HTTPException) as e:
            run(m.inscriptions_quote(m.InscribeReq(kind="text", text="hi"), SESSION))
        assert e.value.status_code == 503


class TestMintOrdering:
    """The user must never be charged for an inscription that does not exist."""

    def _balance(self, zats):
        async def fake(wn, cmd, args=None):
            if cmd == "balance":
                return {"confirmed_orchard_balance": zats}
            return {"txids": ["paid"]}
        return fake

    def test_refuses_before_broadcasting_when_the_balance_is_short(self, monkeypatch):
        monkeypatch.setattr(m, "azec", self._balance(1_000))
        with pytest.raises(m.HTTPException) as e:
            run(m.inscriptions_mint(m.InscribeReq(kind="text", text="hi"), dict(SESSION)))
        assert e.value.status_code == 400
        assert [p for p, _, _ in StubSidecar.seen if p == "/mint"] == [], "must not broadcast"

    def test_mints_then_charges(self, monkeypatch):
        monkeypatch.setattr(m, "azec", self._balance(10_000_000))
        r = run(m.inscriptions_mint(m.InscribeReq(kind="text", text="hi"), dict(SESSION)))
        assert r["inscription_id"] == "abc123i0"
        assert r["charged_zats"] == 2_025_000
        assert r["charge_failed"] is False
        paths = [p for p, _, _ in StubSidecar.seen]
        assert paths.index("/quote") < paths.index("/mint")

    def test_keeps_the_inscription_when_the_charge_fails(self, monkeypatch):
        # The inscription is already on chain and belongs to the user. Failing
        # the request here would tell them it did not happen, which is false.
        async def balance_then_broken(wn, cmd, args=None):
            if cmd == "balance":
                return {"confirmed_orchard_balance": 10_000_000}
            raise RuntimeError("send failed")
        monkeypatch.setattr(m, "azec", balance_then_broken)
        r = run(m.inscriptions_mint(m.InscribeReq(kind="text", text="hi"), dict(SESSION)))
        assert r["inscription_id"] == "abc123i0"
        assert r["charged_zats"] == 0
        assert r["charge_failed"] is True

    def test_a_view_only_session_must_supply_a_seed_to_pay(self, monkeypatch):
        monkeypatch.setattr(m, "azec", self._balance(10_000_000))
        session = dict(SESSION, view_only=True)
        r = run(m.inscriptions_mint(m.InscribeReq(kind="text", text="hi"), session))
        # Minted, but unpaid: no seed was given, and we do not fail the mint.
        assert r["inscription_id"] == "abc123i0"
        assert r["charge_failed"] is True
