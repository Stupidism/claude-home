#!/usr/bin/env python3
"""
PTY wrapper for Codex TUI sessions under Symphony remote-control.

The poller redirects run-ticket.sh stdio to per-ticket log files, so without
a PTY the codex TUI refuses to start. Allocating a pty also lets the codex
desktop app register the session and surface its details.

Usage:
    python3 codex-pty-wrapper.py <prompt-file> [extra-codex-args...]

The prompt file is read and deleted immediately after reading; its contents
become codex's initial PROMPT argument.

The PTY scan loop mirrors the claude wrapper: scan output for a rate-limit
banner so the poller can pause the session (see poll-tickets.mts
RATE_LIMIT_PATTERN, which matches both Claude's "You've hit your limit" and
generic "rate limit" text). The matched line is forwarded to stdout so it
lands in symphony-<ticket>.log; on non-zero exit, dump the cleaned tail too.
"""

import pty, os, subprocess, sys, signal, re


prompt = open(sys.argv[1]).read()
os.unlink(sys.argv[1])
extra_args = sys.argv[2:]

codex_bin = os.environ.get('CODEX_BIN', 'codex')

cmd = [codex_bin] + extra_args + [prompt]

master_fd, slave_fd = pty.openpty()
proc = subprocess.Popen(
    cmd,
    stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
    close_fds=True, start_new_session=True,
)
os.close(slave_fd)


def forward_signal(signum, frame):
    try:
        os.killpg(proc.pid, signum)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        os.close(master_fd)
    except OSError:
        pass


signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)
signal.signal(signal.SIGHUP, forward_signal)

# Match the poller's RATE_LIMIT_PATTERN (poll-tickets.mts):
# /You've hit your limit|rate.?limit/i — case-insensitive, accepts either
# "rate-limit" / "ratelimit" / "rate limit". Require a line terminator so we
# only forward a complete banner line, not arbitrary text mid-stream.
RATE_LIMIT_RE = re.compile(
    rb"(?:You(?:'|\xe2\x80\x99)ve hit your limit|rate[- ]?limit)[^\r\n]*[\r\n]",
    re.IGNORECASE,
)
ANSI_RE = re.compile(
    rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b\x0c\x0e-\x1f]"
)
SCAN_BUF_MAX = 8192
ERROR_TAIL_MAX = 4096
scan_buf = b""
rate_limit_hit = False

while True:
    try:
        data = os.read(master_fd, 4096)
        if not data:
            break
    except OSError:
        break
    scan_buf = (scan_buf + data)[-SCAN_BUF_MAX:]
    m = RATE_LIMIT_RE.search(ANSI_RE.sub(b"", scan_buf))
    if m:
        line = m.group(0).rstrip(b"\r\n")
        try:
            os.write(1, line + b"\n")
        except OSError:
            pass
        rate_limit_hit = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.terminate()
            except Exception:
                pass
        break

try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        proc.kill()
    proc.wait()

# Surface codex's exit error tail in the log. The TUI output is otherwise
# discarded, so without this a failing codex run leaves the log empty.
if proc.returncode != 0 and not rate_limit_hit and scan_buf:
    tail = ANSI_RE.sub(b"", scan_buf)[-ERROR_TAIL_MAX:]
    if tail.strip():
        try:
            os.write(1, b"--- codex pty output (tail) ---\n")
            os.write(1, tail)
            if not tail.endswith(b"\n"):
                os.write(1, b"\n")
            os.write(1, b"--- end codex pty output ---\n")
        except OSError:
            pass

sys.exit(proc.returncode)
