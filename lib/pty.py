#!/usr/bin/env python3
r"""Give one dev server a real terminal, for xerb.

macOS script(1) refuses a non-tty stdin, so a daemon that spawns with pipes
cannot use it. pty.fork() does the same job: the dev server gets a controlling
tty (colors, prompts, Vite's keyboard shortcuts, Next's "use 3001 instead?"),
while the daemon keeps ordinary pipes on both ends.

  python3 pty.py [<rows> <cols>] <command>

  stdin  -> the terminal's input
  stdout <- the terminal's raw output, escapes intact
  fd 3   -> one "<rows> <cols>\n" line per resize

Exits with the command's exit code, or 128+N if a signal took it. SIGTERM here
needs no handler: python dies, the master closes, the child gets SIGHUP, and
the tree goes with it.
"""
import fcntl, os, select, struct, sys, termios

# This file is named pty.py, and python puts the script's own directory first
# on sys.path, so a bare `import pty` would import this file instead of the
# standard library's. Drop our directory, then import for real.
_here = os.path.dirname(os.path.realpath(__file__))
sys.path = [p for p in sys.path if os.path.realpath(p or ".") != _here]
import pty  # noqa: E402

DEFAULT_ROWS, DEFAULT_COLS = 24, 80
RESIZE_FD = 3


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    # A blocking pipe write can still come up short; backpressure on stdout is
    # the child's problem to wait out, not ours to drop bytes over.
    while data:
        data = data[os.write(fd, data):]


def main(argv):
    if len(argv) == 3:
        rows, cols, cmd = int(argv[0]), int(argv[1]), argv[2]
    elif len(argv) == 1:
        rows, cols, cmd = DEFAULT_ROWS, DEFAULT_COLS, argv[0]
    else:
        sys.stderr.write("usage: pty.py [<rows> <cols>] <command>\n")
        return 2

    pid, master = pty.fork()
    if pid == 0:
        # Child: fd 0/1/2 are the slave. Sizing it here, before exec, means the
        # command never reads a 0x0 window, not even for an instant.
        set_winsize(0, rows, cols)
        os.environ["TERM"] = "xterm-256color"
        os.execvp("sh", ["sh", "-c", cmd])
        os._exit(127)  # only reached if exec itself failed

    # Priority order, not a set: within one select round a queued resize is
    # applied before the input that follows it, so `r 40 100` then `stty size`
    # cannot race.
    sources = [master, RESIZE_FD, 0]
    try:
        os.fstat(RESIZE_FD)
    except OSError:
        sources.remove(RESIZE_FD)  # nobody wired a resize channel
    pending = b""
    while master in sources:
        ready, _, _ = select.select(sources, [], [])
        for fd in [f for f in sources if f in ready]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""  # EIO on the master is the child hanging up
            if not data:
                sources.remove(fd)
                continue
            if fd == master:
                write_all(1, data)
            elif fd == 0:
                write_all(master, data)
            else:
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    parts = line.split()
                    if len(parts) == 2 and all(p.isdigit() for p in parts):
                        # The kernel sends SIGWINCH to the foreground group for
                        # us, so the child hears about this on its own.
                        set_winsize(master, int(parts[0]), int(parts[1]))

    code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
