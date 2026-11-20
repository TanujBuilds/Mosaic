"""Drive the portable setup in an owned pseudo-terminal."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, subject, width, terminal, plain, raw_steps = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, int(width), 0, 0))
before = termios.tcgetattr(slave)
env = dict(os.environ, TERM=terminal)
env.pop("NO_COLOR", None)
if plain == "yes":
    env["NO_COLOR"] = ""
child = subprocess.Popen([node, subject], stdin=slave, stdout=slave,
                         stderr=slave, env=env, start_new_session=True)
output = bytearray()
offset = 0
deadline = time.monotonic() + 6

def expect(marker):
    global offset
    marker = marker.encode()
    while time.monotonic() < deadline:
        found = output.find(marker, offset)
        if found != -1:
            offset = found + len(marker)
            return
        if child.poll() is not None:
            break
        if select.select([master], [], [], 0.04)[0]:
            output.extend(os.read(master, 65536))
        if len(output) > 512 * 1024:
            raise RuntimeError("setup output exceeded its bound")
    raise RuntimeError("setup timed out waiting for " + repr(marker))

try:
    for marker, keys in json.loads(raw_steps):
        expect(marker)
        if isinstance(keys, int):
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, keys, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
        else:
            os.write(master, keys.encode())
    expect("MOSAIC_SETUP_RESULT ")
    if child.wait(timeout=2) != 0:
        raise RuntimeError("setup subject failed")
    if termios.tcgetattr(slave) != before:
        raise RuntimeError("setup did not restore the terminal mode")
    sys.stdout.buffer.write(output)
except RuntimeError as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(1)
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=2)
    os.close(master)
    os.close(slave)
