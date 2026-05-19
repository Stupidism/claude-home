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
"""

import pty, os, subprocess, sys, signal


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

while True:
    try:
        data = os.read(master_fd, 4096)
        if not data:
            break
    except OSError:
        break

try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        proc.kill()
    proc.wait()

sys.exit(proc.returncode)
