#!/usr/bin/env python3
"""A stand-in for zingo-cli's interactive prompt with ZINGO_FRAMED=1.

It speaks the same wire protocol as ZAIM's patched binary: one command per
stdin line, each reply ending in a frame line. Behavior is scripted by command:

  balance            JSON object
  echo <args...>     JSON list of the args as parsed (checks quoting)
  sleep <secs>       sleeps, then replies ok (drives timeouts)
  fail               error reply
  noise              reply preceded by CLI chatter that must be stripped
  crash              exits without replying
  quit               replies and exits
"""
import json
import shlex
import sys
import time

FRAME = "\x1eZINGO-END "


def reply(text, ok=True):
    print(text, flush=True)
    print(FRAME + ("ok" if ok else "err"), flush=True)


def main():
    if "--slow-start" in sys.argv:
        time.sleep(float(sys.argv[sys.argv.index("--slow-start") + 1]))
    print("Launching zingo-cli", file=sys.stderr, flush=True)
    for line in sys.stdin:
        tokens = shlex.split(line)
        if not tokens:
            print(FRAME + "ok", flush=True)
            continue
        cmd, args = tokens[0], tokens[1:]
        if cmd == "balance":
            reply(json.dumps({"confirmed_ironwood_balance": 9660000,
                              "confirmed_orchard_balance": 0}))
        elif cmd == "echo":
            reply(json.dumps(args))
        elif cmd == "sleep":
            time.sleep(float(args[0]))
            reply(json.dumps({"slept": float(args[0])}))
        elif cmd == "fail":
            reply("Error: Send error.\ncaused by: Insufficient balance", ok=False)
        elif cmd == "noise":
            print("Save task shutdown successfully.", flush=True)
            reply(json.dumps({"clean": True}))
        elif cmd == "crash":
            sys.exit(3)
        elif cmd == "quit":
            reply("Zingo CLI quit successfully.")
            return
        else:
            reply(f"unknown command {cmd}", ok=False)


if __name__ == "__main__":
    main()
