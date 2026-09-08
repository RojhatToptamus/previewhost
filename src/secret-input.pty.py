"""Executed terminal regressions. Only synthetic input reaches this disposable PTY."""
import errno
import hashlib
import json
import os
import pty
import select
import shlex
import signal
import subprocess
import sys
import termios
import time

node, module = sys.argv[1:]
driver = """
import {readSecretInput} from MODULE;
import {createHash} from 'node:crypto';
try {
  const value = await readSecretInput(process.argv[1] === 'stdin', new AbortController().signal);
  console.log(JSON.stringify({accepted:true, digest:createHash('sha256').update(value).digest('hex')}));
} catch(error) { console.log(JSON.stringify({accepted:false, code:error.code})); }
""".replace('MODULE', json.dumps(module))
environment = {'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}


def read(fd, needle=None, seconds=1):
    deadline = time.monotonic() + seconds
    output = b''
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output += chunk
        if needle and needle in output:
            break
    return output


def terminal(mode, chunks, shell=False):
    master, slave = pty.openpty()
    command = [node, '--input-type=module', '-e', driver, mode]
    process = subprocess.Popen(['/bin/sh', '-i'] if shell else command,
                               stdin=slave, stdout=slave, stderr=slave,
                               env=environment, start_new_session=True)
    os.close(slave)
    output = b''
    try:
        if shell:
            output += read(master, seconds=0.1)
            os.write(master, (' '.join(shlex.quote(part) for part in command) + '\n').encode())
        output += read(master, b'"accepted":false' if mode == 'stdin' else b'Secret value', 3)
        for content, delay in chunks:
            os.write(master, content)
            output += read(master, seconds=delay)
        output += read(master, seconds=0.2)
        if not shell:  # The resumed interactive shell owns its own prompt's terminal mode.
            assert termios.tcgetattr(master)[3] & termios.ECHO, 'Terminal echo was not restored.'
        return output
    finally:
        try:
            if shell and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                # The direct driver has no descendants. Reap its normal exit before
                # signaling: macOS killpg can return EPERM for an exited group.
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if shell:
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait(timeout=1)
        finally:
            os.close(master)


normal = 'FAKE_hidden_ü'.encode()
output = terminal('hidden', [(normal + b'\r', 0.2)])
assert normal not in output and hashlib.sha256(normal).hexdigest().encode() in output

paste = b'FAKE_multiline\nsecond line\n'
output = terminal('hidden', [(b'\x1b[200~' + paste + b'\x1b[201~\r', 0.2)])
assert paste not in output and hashlib.sha256(paste).hexdigest().encode() in output

output = terminal('hidden', [(b'FAKE_canceled\x03', 0.2)])
assert b'FAKE_canceled' not in output and b'"code":"CLOSED"' in output

output = terminal('stdin', [])
assert b'"code":"INVALID_INPUT"' in output and b'Secret value' not in output

tail = b'FAKE_OVERSIZE_PASTE_TAIL'
output = terminal('hidden', [(b'\x1b[200~' + b'A' * 4100, 0.2),
                             (tail + b'\x1b[201~\r', 0.3)], shell=True)
assert tail not in output and b'"code":"INVALID_INPUT"' in output
print(json.dumps({'checks': 5, 'hiddenInput': True, 'terminalRestored': True}))
