import test from 'node:test';
import assert from 'node:assert/strict';
import net, { type Socket } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { databaseRedactions, probeDatabase, validateDatabaseUrl } from './database-connections.js';

test('database URLs specify the same local credentials and database that the probe uses', () => {
  assert.equal(validateDatabaseUrl('postgres', 'postgresql://alice:s%40cret@127.0.0.1:5432/app'), 'postgresql://alice:s%40cret@127.0.0.1:5432/app');
  assert.equal(validateDatabaseUrl('redis', 'redis://:secret@127.0.0.1:6379/0'), 'redis://:secret@127.0.0.1:6379/0');
  assert.equal(validateDatabaseUrl('redis', 'redis://127.0.0.1:6379/1'), 'redis://127.0.0.1:6379/1');
  for (const value of [
    'postgresql://alice:secret@localhost:5432/app', 'postgresql://alice:secret@127.1:5432/app',
    'postgresql://alice:secret@127.0.0.1/app', 'postgresql://alice:secret@127.0.0.1:5432/',
    'postgresql://127.0.0.1:5432/app', 'postgresql://alice:secret@127.0.0.1:5432/app?sslmode=require',
    'postgresql://alice:secret@127.0.0.1:5432/app#', 'postgresql://alice:secret@127.0.0.1:5432/a/../app',
    'postgresql://alice:secret@127.0.0.1:5432/%2e%2e/app', 'postgresql://alice:secret@127.0.0.1:5432/app/other',
    'postgresql://alice:secret@127.0.0.1:5432/app?host=/tmp', 'postgresql://alice:secret@127.0.0.1:5432,localhost:5432/app',
    'postgresql://alice:%00secret@127.0.0.1:5432/app', 'postgresql://alice:secret@127.0.0.1:65536/app',
    'redis://:secret@127.0.0.1:6379/0',
  ]) assert.throws(() => validateDatabaseUrl('postgres', value), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'INVALID_INPUT');
    assert.ok(!String(error).includes('secret')); return true;
  });
  for (const value of ['rediss://:secret@127.0.0.1:6379/0', 'redis://:secret@127.0.0.1:6379/-1', 'redis://:secret@127.0.0.1:6379/01',
    'redis://alice@127.0.0.1:6379/0', 'redis://alice:@127.0.0.1:6379/0']) {
    assert.throws(() => validateDatabaseUrl('redis', value));
  }
  const redactions = databaseRedactions('postgresql://alice:s%40cret@127.0.0.1:5432/app');
  assert.ok(redactions.includes('s@cret') && redactions.includes('s%40cret'));
});

test('hanging database authentication is bounded, canceled and closes its connection', async () => {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('data', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    for (const type of ['postgres', 'redis'] as const) {
      const url = type === 'postgres' ? `postgresql://alice:never-expose@127.0.0.1:${port}/app` : `redis://:never-expose@127.0.0.1:${port}/0`;
      const started = performance.now();
      await assert.rejects(probeDatabase(type, url, { signal: new AbortController().signal, timeoutMs: 100 }), (error: unknown) => {
        assert.ok(!String(error).includes('never-expose')); return true;
      });
      assert.ok(performance.now() - started < 1500);
      await pause(20);
      assert.equal(sockets.size, 0);
      const controller = new AbortController();
      const work = probeDatabase(type, url, { signal: controller.signal, timeoutMs: 5000 });
      await pause(30); controller.abort();
      await assert.rejects(work, { code: 'CLOSED' });
      await pause(20);
      assert.equal(sockets.size, 0);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('PostgreSQL startup cannot inherit host credentials, TLS or connection options', async () => {
  let startup = Buffer.alloc(0);
  const server = net.createServer((socket) => { socket.on('data', (chunk) => { startup = Buffer.concat([startup, chunk]); socket.destroy(); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const selected = ['PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGSSLMODE', 'PGSSLNEGOTIATION', 'PGOPTIONS', 'PGREPLICATION', 'PGCLIENT_ENCODING', 'PGAPPNAME'];
  const previous = new Map(selected.map((key) => [key, process.env[key]]));
  for (const key of selected) process.env[key] = 'ambient-secret';
  process.env.PGSSLMODE = 'require';
  process.env.PGSSLNEGOTIATION = 'direct';
  try {
    await assert.rejects(probeDatabase('postgres', `postgresql://explicit@127.0.0.1:${(server.address() as net.AddressInfo).port}/app`,
      { signal: new AbortController().signal, timeoutMs: 500 }));
    assert.ok(startup.length > 8);
    assert.equal(startup.readInt32BE(4), 196608); // A cleartext PG startup, not SSLRequest.
    const fields = startup.subarray(8).toString();
    assert.ok(fields.includes('user\0explicit\0'));
    assert.ok(fields.includes('database\0app\0'));
    assert.ok(fields.includes('options\0 \0'));
    assert.ok(!fields.includes('ambient-secret'));
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
