#!/usr/bin/env python3
"""
PTY wrapper for Claude Code remote-control sessions.

Allocates a pseudo-terminal so --remote-control registers the session on
claude.ai. Strips ANTHROPIC_API_KEY so Claude uses OAuth auth instead of
API key auth (which bypasses session registration).

Usage:
    python3 pty-wrapper.py <prompt-file> [--session-id <uuid> | --resume <uuid>]

The prompt file is read and deleted immediately after reading.
"""

import pty, os, subprocess, sys, signal, re

prompt = open(sys.argv[1]).read()
os.unlink(sys.argv[1])
session_args = sys.argv[2:]  # ['--session-id', '<uuid>'] or ['--resume', '<uuid>']

env = os.environ.copy()
for key in [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY',
]:
    env.pop(key, None)

ticket_id = os.environ.get('TICKET_ID', 'WOR-?')
branch = os.environ.get('BRANCH', '')
slug = branch.replace(f"feat/{ticket_id}-", "", 1)
session_name = f"[{ticket_id}] {slug}"

# Only pass --name when creating a new session (--session-id).
# On resume (--resume), --name causes a duplicate entry in the desktop UI.
is_new_session = '--session-id' in session_args
name_args = ['--name', session_name] if is_new_session else []

# Enable TypeScript LSP plugin so the agent has diagnostics/hover without
# needing to manually re-read type definition files.
_lsp_plugin = os.path.expanduser(
    '~/.claude/plugins/cache/claude-plugins-official/typescript-lsp/1.0.0'
)
lsp_args = ['--plugin-dir', _lsp_plugin] if os.path.isdir(_lsp_plugin) else []

# Load user + project + local settings so permissions.deny, enabledPlugins, etc. apply.
# Use effort=medium to avoid unnecessary extended thinking in autonomous mode.
cmd = (
    ['claude', '--dangerously-skip-permissions', '--remote-control',
     '--setting-sources=user,project,local', '--effort', 'medium']
    + lsp_args + name_args + session_args + [prompt]
)

master_fd, slave_fd = pty.openpty()
# start_new_session=True puts claude (and every descendant it forks — MCP
# servers, LSP, tool subprocesses) into its own session+PGID. That gives the
# parent (run-ticket.sh) a single PGID to signal, and prevents claude from
# becoming an orphan reparented to launchd when this wrapper is SIGKILL'd.
proc = subprocess.Popen(
    cmd,
    stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
    env=env, close_fds=True, start_new_session=True,
)
os.close(slave_fd)


def forward_signal(signum, frame):
    # Forward to claude's entire process group so MCP servers and other
    # descendants get the signal too — `proc.terminate()` alone only hits
    # the immediate child and leaves descendants orphaned.
    try:
        os.killpg(proc.pid, signum)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except Exception:
            pass


# Forward INT/TERM (poller shutdown) and HUP (parent terminal/poller exit
# under launchd or session-leader death) so claude can clean up before dying.
signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)
signal.signal(signal.SIGHUP, forward_signal)

# Scan PTY output for the rate-limit banner so the poller can pause the
# session (see poll-tickets.mts RATE_LIMIT_PATTERN). The TUI output is
# otherwise discarded — it's visible on claude.ai. On macOS, os.read
# returns b'' (EOF) instead of raising OSError when the PTY slave closes.
# Require the full banner (with "resets <time>") terminated by \r or \n
# so we only match a complete line and avoid false positives on arbitrary
# user-typed text that happens to contain "You've hit your limit".
RATE_LIMIT_RE = re.compile(
    rb"You(?:'|\xe2\x80\x99)ve hit your limit[^\r\n]*resets[^\r\n]*[\r\n]",
    re.IGNORECASE,
)
# Strip ANSI CSI/OSC sequences and C0 control bytes except \t (0x09),
# \n (0x0a), and \r (0x0d) — the latter two must survive so RATE_LIMIT_RE
# can see the line terminator.
ANSI_RE = re.compile(
    rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b\x0c\x0e-\x1f]"
)
SCAN_BUF_MAX = 8192
ERROR_TAIL_MAX = 4096  # bytes of buffer to dump on non-zero exit
scan_buf = b""  # raw bytes — ANSI is stripped on the whole buffer each iter
                # so escape sequences split across reads are handled cleanly.
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
        # Write the cleaned matched line to stdout so it lands in
        # symphony-<ticket>.log where the poller can grep it.
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

# Surface claude's exit error. When claude exits with a non-zero status,
# the TUI output (including stderr) is otherwise discarded by the scan
# loop, leaving symphony-<ticket>.log with only the run-ticket.sh prelude.
# Dump the tail of scan_buf — with ANSI stripped — so the actual error
# message lands in the log. Skip when we already wrote the rate-limit
# banner, since that terminated the child ourselves.
if proc.returncode != 0 and not rate_limit_hit and scan_buf:
    tail = ANSI_RE.sub(b"", scan_buf)[-ERROR_TAIL_MAX:]
    if tail.strip():
        try:
            os.write(1, b"--- claude pty output (tail) ---\n")
            os.write(1, tail)
            if not tail.endswith(b"\n"):
                os.write(1, b"\n")
            os.write(1, b"--- end claude pty output ---\n")
        except OSError:
            pass

sys.exit(proc.returncode)
