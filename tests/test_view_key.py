"""View-key sign in: key derivation, network binding, and the seal round trip.

The failure mode this guards against is a wallet the server can open once and
never open again. Under seed sign in the seal key comes from the seed; under
view-key sign in the server has no seed, so the key must come from the UFVK
alone and must keep coming out the same on every later sign in.

Chain behaviour (sync, balance, refusal to spend) is proven live against
testnet and recorded in docs/view-key-signin-plan.md. These tests cover the
parts that do not need a chain, which is where the subtle bugs live.
"""

import os
import shutil
import tempfile

import pytest

os.environ.setdefault("WALLET_DIR", tempfile.mkdtemp(prefix="zaim-test-"))
os.environ.setdefault("ZCASH_CHAIN", "mainnet")

import api.main as m  # noqa: E402  (must follow the env set above)

# Read the directory back off the module rather than trusting the env we just
# set: whichever test module imports api.main first fixes it for the whole run,
# and a test writing to a path the module is not using passes for the wrong
# reason or fails for no reason.
WDIR = m.WDIR

# Structurally valid, never funded, never used. Only its shape matters here.
MAIN_UFVK = "uview1" + "qz" * 80
TEST_UFVK = "uviewtest1" + "qz" * 80
SEED = "abandon " * 23 + "art"


@pytest.fixture(autouse=True)
def clean_wallet_dir():
    for e in os.listdir(WDIR):
        p = os.path.join(WDIR, e)
        shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)
    m.wallet_keys.clear()
    yield


class TestNormalize:
    def test_accepts_a_key_for_the_running_network(self):
        assert m.normalize_ufvk(MAIN_UFVK) == MAIN_UFVK

    def test_trims_whitespace(self):
        assert m.normalize_ufvk("  " + MAIN_UFVK + "\n") == MAIN_UFVK

    def test_refuses_the_other_network(self):
        # A testnet key on a mainnet server syncs nothing and looks like an
        # empty wallet, which reads to a user as lost funds.
        with pytest.raises(m.HTTPException) as e:
            m.normalize_ufvk(TEST_UFVK)
        assert "wrong network" in e.value.detail

    @pytest.mark.parametrize("bad", ["", "hello", "uview1", SEED, "zxviews1" + "qz" * 80])
    def test_refuses_junk(self, bad):
        # A seed pasted into the view-key field is the dangerous one: it must
        # never be accepted and quietly forwarded to the CLI.
        with pytest.raises(m.HTTPException):
            m.normalize_ufvk(bad)


class TestFingerprint:
    def test_is_stable(self):
        assert m.ufvk_fingerprint(MAIN_UFVK) == m.ufvk_fingerprint(MAIN_UFVK)

    def test_ignores_surrounding_whitespace(self):
        assert m.ufvk_fingerprint(" " + MAIN_UFVK + " ") == m.ufvk_fingerprint(MAIN_UFVK)

    def test_differs_between_keys(self):
        assert m.ufvk_fingerprint(MAIN_UFVK) != m.ufvk_fingerprint(TEST_UFVK)

    def test_does_not_contain_the_key(self):
        assert MAIN_UFVK[6:20] not in m.ufvk_fingerprint(MAIN_UFVK)

    def test_matches_the_wasm_module(self):
        # src/ai/ufvk.js must agree with the server or every sign in lands in a
        # different wallet directory than the one it left.
        import hashlib
        want = hashlib.sha256(b"zaim-ufvk-v1:" + MAIN_UFVK.encode()).hexdigest()[:16]
        assert m.ufvk_fingerprint(MAIN_UFVK) == want


class TestSealKeySeparation:
    def test_view_and_seed_keys_differ(self):
        fp = m.ufvk_fingerprint(MAIN_UFVK)
        assert m.ufvk_key(MAIN_UFVK, fp) != m.seed_key(SEED, fp)

    def test_view_key_is_deterministic(self):
        fp = m.ufvk_fingerprint(MAIN_UFVK)
        assert m.ufvk_key(MAIN_UFVK, fp) == m.ufvk_key(MAIN_UFVK, fp)

    def test_key_is_bound_to_its_fingerprint(self):
        assert m.ufvk_key(MAIN_UFVK, "aaaa") != m.ufvk_key(MAIN_UFVK, "bbbb")


class TestSealRoundTrip:
    """The recovery path: seal on sign out, reopen on the next sign in with a
    key rederived from the UFVK, no seed involved at any point."""

    def _make_wallet(self, wn, body=b"wallet bytes"):
        d = os.path.join(WDIR, wn)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "zingo-wallet.dat"), "wb") as f:
            f.write(body)
        return d

    def test_seal_then_unseal_with_a_rederived_key(self):
        fp = m.ufvk_fingerprint(MAIN_UFVK)
        wn = "zv_" + fp
        d = self._make_wallet(wn, b"the real wallet")

        assert m.seal_wallet(wn, m.ufvk_key(MAIN_UFVK, fp)) is True
        assert not os.path.isdir(d), "plaintext must be gone after sealing"
        assert os.path.exists(d + ".sealed")

        # A later sign in knows only the UFVK.
        assert m.unseal_wallet(wn, m.ufvk_key(MAIN_UFVK, fp)) is True
        with open(os.path.join(d, "zingo-wallet.dat"), "rb") as f:
            assert f.read() == b"the real wallet"

    def test_sealed_bytes_do_not_contain_the_plaintext(self):
        fp = m.ufvk_fingerprint(MAIN_UFVK)
        wn = "zv_" + fp
        self._make_wallet(wn, b"SECRETMARKER")
        m.seal_wallet(wn, m.ufvk_key(MAIN_UFVK, fp))
        with open(os.path.join(WDIR, wn + ".sealed"), "rb") as f:
            assert b"SECRETMARKER" not in f.read()

    def test_a_seed_derived_key_cannot_open_a_view_seal(self):
        fp = m.ufvk_fingerprint(MAIN_UFVK)
        wn = "zv_" + fp
        self._make_wallet(wn)
        m.seal_wallet(wn, m.ufvk_key(MAIN_UFVK, fp))
        with pytest.raises(m.HTTPException):
            m.unseal_wallet(wn, m.seed_key(SEED, fp))

    def test_a_different_ufvk_cannot_open_the_seal(self):
        fp = m.ufvk_fingerprint(MAIN_UFVK)
        wn = "zv_" + fp
        self._make_wallet(wn)
        m.seal_wallet(wn, m.ufvk_key(MAIN_UFVK, fp))
        other = "uview1" + "qr" * 80
        with pytest.raises(m.HTTPException):
            m.unseal_wallet(wn, m.ufvk_key(other, fp))

    def test_unseal_reports_absence_rather_than_raising(self):
        assert m.unseal_wallet("zv_nothinghere", b"\x00" * 32) is False


class TestApplyFees:
    """A view-only send must be indistinguishable from a seed-session send, in
    what it costs and in what it looks like on chain."""

    def _run(self, kind, outputs, session=None):
        import asyncio
        s = session or {"z_address": "zs1self", "ua_address": "u1self", "wallet_name": "zv_x"}
        return asyncio.run(m._apply_fees(s, kind, outputs))

    def test_converts_zec_to_zatoshis(self):
        out, _ = self._run("payment", [{"address": "u1dest", "amount": 0.1}])
        assert out[0]["amount"] == 10_000_000

    def test_converts_without_binary_float_error(self):
        # 0.1 * 1e8 in binary floating point is 10000000.000000002.
        out, _ = self._run("payment", [{"address": "u1dest", "amount": 2.3}])
        assert out[0]["amount"] == 230_000_000

    def test_rejects_an_amount_that_rounds_to_nothing(self):
        with pytest.raises(m.HTTPException):
            self._run("payment", [{"address": "u1dest", "amount": 0.000000001}])

    def test_rejects_a_memo_that_will_not_fit(self):
        with pytest.raises(m.HTTPException):
            self._run("payment", [{"address": "u1dest", "amount": 1, "memo": "x" * 600}])

    def test_charges_the_same_fee_as_the_seed_path(self, monkeypatch):
        monkeypatch.setattr(m, "FEE_ADDRESS", "u1house")
        monkeypatch.setattr(m, "FEE_BPS", 50)
        monkeypatch.setattr(m, "FEE_MIN_ZATS", 0)
        out, fee = self._run("payment", [{"address": "u1dest", "amount": 1.0}])
        assert fee == 500_000                       # 0.5% of 1 ZEC
        assert out[-1] == {"address": "u1house", "amount": 500_000}
        assert out[0]["amount"] == 100_000_000      # recipient gets the full amount

    def test_applies_the_fee_floor(self, monkeypatch):
        monkeypatch.setattr(m, "FEE_ADDRESS", "u1house")
        monkeypatch.setattr(m, "FEE_BPS", 50)
        monkeypatch.setattr(m, "FEE_MIN_ZATS", 10_000)
        _, fee = self._run("payment", [{"address": "u1dest", "amount": 0.0001}])
        assert fee == 10_000

    def test_charges_nothing_when_no_fee_is_configured(self, monkeypatch):
        monkeypatch.setattr(m, "FEE_ADDRESS", "")
        out, fee = self._run("payment", [{"address": "u1dest", "amount": 1.0}])
        assert fee == 0 and len(out) == 1

    def test_a_message_is_padded_to_a_fixed_shape(self, monkeypatch):
        async def no_fee():
            return 0
        monkeypatch.setattr(m, "_msg_fee_zats", no_fee)
        out, fee = self._run("message", [{"address": "u1friend", "memo": "hello"}])
        assert fee == 0
        # Padded whether or not a fee rode along, so the two cases look alike.
        assert len(out) == m.MSG_ACTIONS
        assert out[0]["amount"] == m.DUST
        assert all(o["address"] == "u1self" for o in out[1:])

    def test_a_message_keeps_its_shape_when_a_fee_applies(self, monkeypatch):
        async def some_fee():
            return 25_000
        monkeypatch.setattr(m, "_msg_fee_zats", some_fee)
        out, fee = self._run("message", [{"address": "u1friend", "memo": "hello"}])
        assert fee == 25_000
        assert len(out) == m.MSG_ACTIONS, "a paid message must not be longer than a free one"

    def test_a_message_carries_a_reply_address(self, monkeypatch):
        async def no_fee():
            return 0
        monkeypatch.setattr(m, "_msg_fee_zats", no_fee)
        out, _ = self._run("message", [{"address": "u1friend", "memo": "hello"}])
        assert "Reply-to: zs1self" in out[0]["memo"]

    def test_the_treasury_output_carries_no_memo(self, monkeypatch):
        async def some_fee():
            return 25_000
        monkeypatch.setattr(m, "_msg_fee_zats", some_fee)
        monkeypatch.setattr(m, "TREASURY_ADDRESS", "u1treasury")
        out, _ = self._run("message", [{"address": "u1friend", "memo": "hello"}])
        treasury = [o for o in out if o["address"] == "u1treasury"]
        assert treasury and "memo" not in treasury[0]


class TestNamespace:
    """zw_ (seed) and zv_ (view) wallets seal with different keys, so they must
    never collide in the wallet directory."""

    def test_view_wallets_are_prefixed(self):
        assert ("zv_" + m.ufvk_fingerprint(MAIN_UFVK)).startswith("zv_")

    def test_periodic_seal_recognises_view_wallets(self):
        import inspect
        src = inspect.getsource(m.periodic_seal)
        assert "zv_" in src, "idle view wallets would be left as plaintext"
