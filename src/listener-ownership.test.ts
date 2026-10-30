import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { listenerOwnership } from './listener-ownership.js';

const server = `const net = require('net');
let pending = process.argv.length - 1;
for (const host of process.argv.slice(1)) net.createServer().once('error', () => { console.log('unavailable'); }).listen(Number(process.env.PORT), host, () => { if (!--pending) console.log('listening'); });
setInterval(() => {}, 1000);`;

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as net.AddressInfo;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('only an owned 127.0.0.1 listener counts as owned, so a ::1-only port reads missing', { skip: process.platform === 'win32' && 'The supervisor check runs on macOS and Linux' }, async t => {
  for (const [hosts, expected] of [[['::1'], 'missing'], [['127.0.0.1'], 'owned'], [['127.0.0.1', '::1'], 'owned']] as const) {
    const port = await freePort();
    const child = spawn(process.execPath, ['-e', server, ...hosts], { env: { PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => { child.kill('SIGKILL'); });
    const [line] = await once(child.stdout!, 'data');
    if (String(line).includes('unavailable')) { t.skip('IPv6 loopback is unavailable'); return; }
    // Another user's 127.0.0.1 listener is invisible to lsof on macOS; only an owned one rules it out.
    assert.equal(await listenerOwnership(child.pid!, port), expected, hosts.join(' and '));
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
});
