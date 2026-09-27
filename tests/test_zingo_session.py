"""The long-lived session layer, against a fake zingo that speaks the same
framed protocol. What matters here is ordering and failure: a reply must never
reach the wrong caller, and nothing may ever kill a session."""
import json
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import zingo_session as zs  # noqa: E402

FAKE = [sys.executable, os.path.join(os.path.dirname(__file__), "fake_zingo.py")]


@pytest.fixture
def session():
    s = zs.Session(FAKE, dict(os.environ), "t")
    yield s
    s.close(5)


def test_a_json_reply_comes_back_parsed(session):
    assert session.run("balance")["confirmed_ironwood_balance"] == 9660000


def test_the_first_reply_marks_the_session_ready(session):
    session.run("balance")
    assert session.ready


def test_arguments_survive_the_prompt_quoting(session):
    payload = json.dumps([{"address": "u1x", "amount": 10000,
                           "memo": "it's \"quoted\"\nand has a newline"}])
    assert session.run("echo", [payload]) == [payload]


def test_a_raw_newline_is_refused_before_it_can_split_a_command(session):
    with pytest.raises(ValueError):
        session.run("echo", ["two\nlines"])


def test_cli_chatter_is_stripped(session):
    assert session.run("noise") == {"clean": True}


def test_an_error_reply_raises_with_its_text(session):
    with pytest.raises(zs.CommandFailed, match="Insufficient balance"):
        session.run("fail")


def test_the_session_survives_an_error(session):
    with pytest.raises(zs.CommandFailed):
        session.run("fail")
    assert session.run("balance")["confirmed_orchard_balance"] == 0


def test_a_timeout_abandons_the_command_without_killing_the_session(session):
    with pytest.raises(zs.CommandTimeout):
        session.run("sleep", ["1"], timeout=0.2)
    assert session.alive
    # The late reply to the abandoned sleep must not be handed to this caller.
    assert session.run("echo", ["after"], timeout=5) == ["after"]


def test_concurrent_callers_each_get_their_own_reply(session):
    results = {}

    def call(i):
        results[i] = session.run("echo", [str(i)], timeout=10)

    threads = [threading.Thread(target=call, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == {i: [str(i)] for i in range(20)}


def test_a_crash_fails_the_waiting_caller_instead_of_hanging(session):
    t0 = time.time()
    with pytest.raises(zs.SessionDead):
        session.run("crash", timeout=10)
    assert time.time() - t0 < 5
    assert not session.alive


def test_a_dead_session_refuses_new_commands_immediately(session):
    with pytest.raises(zs.SessionDead):
        session.run("crash", timeout=10)
    t0 = time.time()
    with pytest.raises(zs.SessionDead):
        session.run("balance", timeout=10)
    assert time.time() - t0 < 1


def test_close_quits_cleanly(session):
    assert session.close(5)
    assert not session.alive


def test_commands_queue_behind_a_slow_start():
    s = zs.Session(FAKE + ["--slow-start", "0.5"], dict(os.environ), "slow")
    try:
        assert not s.ready
        assert s.run("balance", timeout=5)["confirmed_ironwood_balance"] == 9660000
        assert s.ready
    finally:
        s.close(5)


def test_the_pool_reuses_a_live_session_and_replaces_a_dead_one():
    pool = zs.Pool()
    a = pool.start("w", FAKE, dict(os.environ))
    assert pool.start("w", FAKE, dict(os.environ)) is a
    with pytest.raises(zs.SessionDead):
        a.run("crash", timeout=5)
    assert pool.get("w") is None
    b = pool.start("w", FAKE, dict(os.environ))
    assert b is not a and b.alive
    assert pool.close("w", 5)
    assert pool.names() == []


def test_parse_skips_a_notice_before_the_json():
    text = ("This session is deliberately offline (--offline): nothing touches the network.\n"
            '{\n  "confirmed_ironwood_balance": 5\n}')
    assert zs.parse(text) == {"confirmed_ironwood_balance": 5}


def test_parse_keeps_pseudo_json_raw_for_the_regex_parsers():
    text = "Wallet backup info:\n{\n    seed phrase: abandon art\n    birthday: 1\n}"
    assert zs.parse(text) == {"raw": text}
