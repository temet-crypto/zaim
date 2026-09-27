"""Long-lived zingo-cli sessions, one per open wallet.

Why this exists: zingo v6 sends only over the Nym mixnet, and bringing the
mixnet up costs about two minutes per process. Spawning a process per command,
which is how ZAIM ran v0.x, made every send wait two minutes. One process per
wallet pays that once, and a send inside a warm session takes seconds.

The protocol is the interactive prompt driven over pipes. ZAIM's patched
zingo-cli, run with ZINGO_FRAMED=1, ends every reply with one frame line on
stdout (`\\x1eZINGO-END ok` or `... err`) and puts errors on stdout ahead of it,
so each command reads back as exactly one reply. zingo reads stdin one line at a
time and finishes a command before reading the next, so replies arrive in the
order commands were written.

Two rules that are easy to break and expensive when broken:

- **Never kill a session.** A zingo process killed mid-sync leaves a "sync
  already running" flag inside the wallet file, and every later sync on that
  wallet fails until it is rebuilt from the seed. Sessions end with `quit`. A
  command that times out is abandoned, not cancelled: its reply is discarded
  when it eventually arrives, and the session carries on.
- **One writer per wallet file.** Nothing else may run zingo against a data dir
  while its session is alive. Offline one-shot reads happen only before a
  session starts.
"""

from __future__ import annotations

import collections
import json
import os
import shlex
import subprocess
import threading
import time

FRAME = "\x1eZINGO-END "
# Output lines that are the CLI talking about itself, not a command's reply.
_NOISE = ("Launching ", "Save task", "Zingo CLI quit", "Creating a new wallet")


class SessionDead(Exception):
    """The process is gone. The caller may start a new session."""


class CommandTimeout(Exception):
    """No reply in time. The command may still complete: a send that times out
    has an UNKNOWN outcome and must never be retried blindly."""


class CommandFailed(Exception):
    """zingo answered with an error. Its text is in args[0]; it can contain
    paths and must be sanitized before it reaches a client."""


class _Waiter:
    __slots__ = ("event", "ok", "text", "abandoned")

    def __init__(self):
        self.event = threading.Event()
        self.ok = False
        self.text = ""
        self.abandoned = False


class Session:
    """One zingo-cli process in interactive mode."""

    def __init__(self, argv: list[str], env: dict, name: str = ""):
        self.name = name
        self.started = time.time()
        self.last_used = self.started
        self.ready = False              # first reply received: startup is over
        self._lock = threading.Lock()   # guards writes + the waiter queue
        self._waiters: collections.deque[_Waiter] = collections.deque()
        self._buf: list[str] = []
        self._eof = False               # stdout closed: no reply can ever come
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=200)
        self.proc = subprocess.Popen(
            argv, env={**env, "ZINGO_FRAMED": "1"},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    # ── readers ──────────────────────────────────────────────────────────────
    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            # rustyline may print the prompt without a newline, gluing it to the
            # front of the next line. The frame marker is unambiguous anywhere.
            idx = line.find(FRAME)
            if idx >= 0:
                if line[:idx].strip():
                    self._buf.append(line[:idx])
                ok = line[idx + len(FRAME):].strip() == "ok"
                self._deliver(ok)
            else:
                self._buf.append(line)
        self._fail_all()

    def _read_stderr(self):
        for line in self.proc.stderr:
            self.stderr_tail.append(line.rstrip("\n"))

    def _deliver(self, ok: bool):
        text = "\n".join(l for l in self._buf
                         if l.strip() and not l.strip().startswith(_NOISE)).strip()
        self._buf = []
        self.ready = True
        with self._lock:
            w = self._waiters.popleft() if self._waiters else None
        if w is None:
            return  # a reply nobody asked for; nothing to hand it to
        w.ok, w.text = ok, text
        w.event.set()

    def _fail_all(self):
        with self._lock:
            self._eof = True
            waiters, self._waiters = list(self._waiters), collections.deque()
        for w in waiters:
            w.ok, w.text = False, "session ended"
            w.event.set()

    # ── api ──────────────────────────────────────────────────────────────────
    @property
    def alive(self) -> bool:
        return not self._eof and self.proc.poll() is None

    @property
    def pending(self) -> int:
        with self._lock:
            return len(self._waiters)

    def run(self, command: str, args: list | None = None, timeout: float = 300):
        """Send one command and return its reply, parsed as JSON when it is."""
        if not self.alive:
            raise SessionDead(self.name)
        line = shlex.join([command] + [str(a) for a in (args or [])])
        if "\n" in line or "\r" in line:
            # One command per line is the whole protocol. json.dumps escapes
            # newlines inside send payloads, so this only trips on a caller bug.
            raise ValueError("a zingo command cannot contain a newline")
        w = _Waiter()
        with self._lock:
            if self._eof:
                raise SessionDead(self.name)
            self._waiters.append(w)
            try:
                self.proc.stdin.write(line + "\n")
                self.proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                self._waiters.remove(w)
                raise SessionDead(self.name)
        self.last_used = time.time()
        if not w.event.wait(timeout):
            # Abandon, never kill: the reply will still arrive, in order, and
            # _deliver hands it to this waiter, which nobody reads any more.
            w.abandoned = True
            raise CommandTimeout(f"{self.name} {command}")
        if not w.ok:
            if w.text == "session ended" and not self.alive:
                raise SessionDead(self.name)
            raise CommandFailed(w.text)
        return parse(w.text)

    def close(self, timeout: float = 120) -> bool:
        """Quit cleanly so zingo saves the wallet. True once the process is gone.
        Never escalates to kill (see the module docstring); a session that will
        not quit is left running and reported."""
        if not self.alive:
            return True
        try:
            with self._lock:
                self.proc.stdin.write("quit\n")
                self.proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError):
            pass
        try:
            self.proc.wait(timeout)
            return True
        except subprocess.TimeoutExpired:
            return False


def parse(text: str):
    """JSON when the reply is JSON. zingo sometimes prints a notice line first
    (an offline run announces itself), so fall back to decoding from the first
    line that opens a JSON value. Anything else comes back as {"raw": text}."""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    if isinstance(text, str):
        offset = 0
        for line in text.splitlines(keepends=True):
            if line.lstrip().startswith(("{", "[")):
                try:
                    value, _ = json.JSONDecoder().raw_decode(text[offset:].lstrip())
                    return value
                except json.JSONDecodeError:
                    pass
            offset += len(line)
    return {"raw": text}


class Pool:
    """Sessions by wallet name. Thread-safe; the async layer calls into it
    from executor threads."""

    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def get(self, name: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(name)
        return s if s and s.alive else None

    def start(self, name: str, argv: list[str], env: dict) -> Session:
        with self._lock:
            s = self._sessions.get(name)
            if s and s.alive:
                return s
            s = Session(argv, env, name)
            self._sessions[name] = s
            return s

    def close(self, name: str, timeout: float = 120) -> bool:
        with self._lock:
            s = self._sessions.get(name)
        if not s:
            return True
        done = s.close(timeout)
        if done:
            with self._lock:
                if self._sessions.get(name) is s:
                    del self._sessions[name]
        return done

    def names(self) -> list[str]:
        with self._lock:
            return [n for n, s in self._sessions.items() if s.alive]

    def stats(self) -> dict:
        with self._lock:
            items = list(self._sessions.items())
        return {n: {"alive": s.alive, "ready": s.ready, "pending": s.pending,
                    "age_s": int(time.time() - s.started)} for n, s in items}
