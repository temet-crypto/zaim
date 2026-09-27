# zingo-cli patches

ZAIM runs a patched zingo-cli. The patch is small and applies to the tag named
in its filename.

`zingolib_v6.0.0.patch`:

- `ZINGO_OVK_DISCARD=1` writes no outgoing viewing key (opt-in; default keeps
  `OvkPolicy::Sender` so a user still sees their own sent history).
- `balance` and `value_transfers` print JSON, like `messages` already does.
  Upstream prints a human format for these two.
- `ZINGO_DESTINATIONS` (comma separated URIs) replaces the curated send
  destination list. Upstream's list is mainnet only, so on testnet every send
  went to a mainnet indexer and failed as "unknown Ironwood anchor". Leave it
  unset on mainnet: the curated list plus the never-the-sync-operator rule is
  the privacy property.
- `ZINGO_FRAMED=1` ends every interactive reply with a frame line on stdout
  (`\x1eZINGO-END ok|err`) and moves errors to stdout ahead of it. This is the
  protocol `api/zingo_session.py` speaks.

Build (linux/amd64, what production runs):

    git clone --branch zingolib_v6.0.0 https://github.com/zingolabs/zingolib.git
    cd zingolib && git apply ../zingo-patches/zingolib_v6.0.0.patch && cp ../zingo-patches/Dockerfile.build .
    docker build --platform linux/amd64 -f Dockerfile.build -t zingo-v6-build .
    # nym-proxy, required: v6 transmits only over the Nym mixnet
    docker run --platform linux/amd64 zingo-v6-build \
      sh -c 'cd zingo-netutils && cargo build --release --features nym --bin nym-proxy'

Dockerfile.build is beside this README (uses BuildKit cache mounts, so a
rebuild after a patch change takes minutes, not a full compile).
