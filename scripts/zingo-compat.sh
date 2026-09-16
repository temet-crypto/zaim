#!/usr/bin/env bash
# Compatibility gate for a zingo-cli upgrade.
#
# ZAIM's API parses zingo's JSON by field name. A version bump that renames or
# restructures any of these silently breaks balances, messages, or sends — and
# it breaks them in production, at runtime, on a wallet holding real money.
# So: run every command ZAIM depends on against BOTH binaries, on the same
# wallet, and diff the SHAPE (key names and types, not values, which legitimately
# differ between runs).
#
#   ./zingo-compat.sh <old-binary> <new-binary> <data-dir> [chain] [server]
#
# Exit 0 = shapes match. Non-zero = a field ZAIM reads has moved.

set -uo pipefail
OLD="${1:?old binary}"; NEW="${2:?new binary}"; DIR="${3:?wallet data dir}"
CHAIN="${4:-testnet}"; SERVER="${5:-https://testnet.zec.rocks:443}"

# Read-only commands. Anything that spends is deliberately excluded: this is a
# compatibility check, not a money test.
CMDS=(balance addresses t_addresses height value_transfers messages notes)

shape() { # collapse JSON to sorted "path:type" lines
  python3 -c '
import json, sys

def walk(o, p=""):
    if isinstance(o, dict):
        for k in sorted(o):
            yield from walk(o[k], p + "." + k)
    elif isinstance(o, list):
        inner = type(o[0]).__name__ if o else "empty"
        yield p + "[]:" + inner
        if o:
            yield from walk(o[0], p + "[]")
    else:
        yield p + ":" + type(o).__name__

raw = sys.stdin.read()
skip = ("Launching", "Save task", "Zingo CLI", "Creating")
lines = [l for l in raw.splitlines() if l.strip() and not l.startswith(skip)]
try:
    print("\n".join(sorted(set(walk(json.loads("\n".join(lines)))))))
except Exception:
    print("NOT-JSON")
'
}

fail=0
for c in "${CMDS[@]}"; do
  a=$("$OLD" --chain "$CHAIN" --server "$SERVER" --data-dir "$DIR" "$c" 2>/dev/null | shape)
  b=$("$NEW" --chain "$CHAIN" --server "$SERVER" --data-dir "$DIR" "$c" 2>/dev/null | shape)
  if [ "$a" == "$b" ]; then
    echo "ok    $c"
  else
    echo "DIFF  $c"
    diff <(echo "$a") <(echo "$b") | sed 's/^/        /'
    fail=1
  fi
done
exit $fail
