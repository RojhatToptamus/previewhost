import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { connectPreviewDaemon } from './client.js';
import { limits, type RuntimeOptions } from './contracts.js';
import { startDaemon } from './daemon.js';
import { PreviewError } from './errors.js';
import { createPreviewRuntime } from './runtime.js';

async function fixture(t: TestContext, authorize?: RuntimeOptions['authorize']) {
  const directory = await mkdtemp(join(tmpdir(), 'previewd transport '));
  const tokenFile = join(directory, 'private', 'token');
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize });
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  t.after(async () => { await client.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, tokenFile, runtime, daemon, client };
}

function control(endpoint: string, token: string, options: {
  path?: string; body?: string; headers?: Record<string, string>; method?: string;
} = {}): Promise<{ status: number; body: { error?: { code: string }; result?: unknown }; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${endpoint}${options.path ?? '/list'}`, {
      method: options.method ?? 'POST', agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }));
    });
    req.on('error', reject); req.end(options.body ?? '{}');
  });
}

test('the authenticated client shares live previews, preserves errors, and closes only its own requests', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'index.html'), 'shared static preview');
  const description = await f.client.inspect({ name: 'shared', type: 'static', directory: f.directory });
  assert.equal(description.cleanup, 'owned-file-server');
  const status = await f.client.start({ name: 'shared', type: 'static', directory: f.directory });
  const ready = await f.client.wait('shared', status.candidate!.id);
  assert.equal(ready.state, 'ready');
  assert.equal(await (await fetch(ready.url!)).text(), 'shared static preview');
  await assert.rejects(f.client.start({ name: 'shared', type: 'static', directory: f.directory }), { code: 'ALREADY_EXISTS' });
  await assert.rejects(f.client.cancel('shared', 'old-id'), { code: 'STALE_ATTEMPT' });
  await f.client.close();
  await assert.rejects(f.client.list(), { code: 'CLOSED' });
  const other = connectPreviewDaemon({ endpoint: f.daemon.endpoint, tokenFile: f.tokenFile });
  t.after(() => other.close());
  assert.equal((await other.get('shared')).active?.id, ready.id);
  assert.equal((await other.logs('shared')).attemptId, ready.id);
  await other.stop('shared');
  await assert.rejects(fetch(ready.url!));
});

test('control authority, content, strict schemas, and body bounds are enforced before execution', async (t) => {
  const f = await fixture(t);
  const token = (await readFile(f.tokenFile, 'utf8')).trim();
  const rejectedHeaders: Array<Record<string, string>> = [{ authorization: 'Bearer wrong' }, { host: 'evil.example' }, { origin: 'http://evil.example' }];
  for (const headers of rejectedHeaders) {
    const response = await control(f.daemon.endpoint, token, { headers, path: '/start', body: '{invalid' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, 'UNAUTHORIZED');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await control(f.daemon.endpoint, token, { body: '{bad' })).body.error?.code, 'INVALID_INPUT');
  assert.equal((await control(f.daemon.endpoint, token, { body: '{"approved":true}' })).body.error?.code, 'INVALID_INPUT');
  assert.equal((await control(f.daemon.endpoint, token, { headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await control(f.daemon.endpoint, token, { headers: { 'content-length': String(limits.controlBytes + 1) } })).body.error?.code, 'INVALID_INPUT');
  // A rejected chunked upload can lose its write side before the JSON error
  // arrives. In either ordering, an otherwise valid start must never execute.
  const oversized = await control(f.daemon.endpoint, token, {
    path: '/start', headers: { 'transfer-encoding': 'chunked' },
    body: JSON.stringify({ spec: { name: 'too-large', type: 'static', directory: f.directory } }) + ' '.repeat(limits.controlBytes),
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
    return undefined;
  });
  if (oversized) assert.equal(oversized.body.error?.code, 'INVALID_INPUT');
  assert.equal((await control(f.daemon.endpoint, token, { path: '/unknown' })).status, 404);
  assert.deepEqual(await f.client.list(), []);
});

test('private token files reject symlinks, broad permissions, and unsafe directories', async (t) => {
  const f = await fixture(t);
  const fifo = join(f.directory, 'private', 'fifo');
  await promisify(execFile)('/usr/bin/mkfifo', [fifo]);
  const fifoClient = connectPreviewDaemon({ endpoint: f.daemon.endpoint, tokenFile: fifo });
  t.after(() => fifoClient.close());
  await assert.rejects(fifoClient.list(), { code: 'UNAUTHORIZED' });
  const linked = join(f.directory, 'private', 'linked-token');
  await symlink(f.tokenFile, linked);
  const linkedClient = connectPreviewDaemon({ endpoint: f.daemon.endpoint, tokenFile: linked });
  t.after(() => linkedClient.close());
  await assert.rejects(linkedClient.list(), { code: 'UNAUTHORIZED' });
  await chmod(f.tokenFile, 0o644);
  await assert.rejects(f.client.list(), { code: 'UNAUTHORIZED' });
  await chmod(f.tokenFile, 0o600);
  await chmod(join(f.directory, 'private'), 0o755);
  await assert.rejects(f.client.list(), { code: 'UNAUTHORIZED' });
  await chmod(join(f.directory, 'private'), 0o700);
  const badDirectory = join(f.directory, 'broad');
  await mkdir(badDirectory, { mode: 0o755 });
  await assert.rejects(startDaemon({ runtime: f.runtime, tokenFile: join(badDirectory, 'token'), port: 0 }), { code: 'UNAUTHORIZED' });
  assert.throws(() => connectPreviewDaemon({ endpoint: 'http://example.com:9400' }), { code: 'INVALID_INPUT' });
  assert.throws(() => connectPreviewDaemon({ endpoint: 'http://token@127.0.0.1:9400' }), { code: 'INVALID_INPUT' });
  assert.throws(() => connectPreviewDaemon({ endpoint: 'http://127.0.0.1' }), { code: 'INVALID_INPUT' });
  assert.doesNotThrow(() => connectPreviewDaemon({ endpoint: 'http://127.0.0.1:80' }));
});

test('unexpected control upgrades and truncated responses reject and release their connections', { timeout: 3_000 }, async (t) => {
  const f = await fixture(t);
  const sockets = new Set<Socket>();
  const closedConnections: Promise<void>[] = [];
  let requests = 0;
  const server = createServer((_request, response) => {
    if (requests++ === 0) {
      response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' }).end();
    } else {
      response.writeHead(200, { 'content-length': '100' });
      response.flushHeaders();
      response.write('{"result":');
      setImmediate(() => response.destroy());
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    closedConnections.push(new Promise<void>((done) => socket.once('close', () => { sockets.delete(socket); done(); })));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const client = connectPreviewDaemon({
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, tokenFile: f.tokenFile,
  });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  await assert.rejects(client.list(), { code: 'DAEMON_UNAVAILABLE' });
  await assert.rejects(client.list(), { code: 'DAEMON_UNAVAILABLE' });
  await client.close();
  await Promise.all(closedConnections);
  assert.equal(sockets.size, 0);
});

test('long waits leave control capacity for exact cancellation, and aborting a waiter does not cancel startup', async (t) => {
  const f = await fixture(t, ({ signal }) => new Promise<boolean>((resolve) => {
    signal.addEventListener('abort', () => resolve(false), { once: true });
  }));
  const status = await f.client.start({ name: 'pending', type: 'command', cwd: f.directory, command: [process.execPath, '-e', 'process.exit(99)'] });
  const id = status.candidate!.id;
  const controller = new AbortController();
  const aborted = f.client.wait('pending', id, { signal: controller.signal }).catch((error: unknown) => error);
  controller.abort();
  assert.equal((await aborted as PreviewError).code, 'CLOSED');
  assert.equal((await f.client.get('pending')).candidate?.id, id);
  let observed = 0;
  let allWaiting!: () => void;
  const entered = new Promise<void>((resolve) => { allWaiting = resolve; });
  const originalWait = f.runtime.wait.bind(f.runtime);
  f.runtime.wait = (...args) => {
    observed++;
    if (observed === limits.controlWaits) allWaiting();
    return originalWait(...args);
  };
  const pending = Array.from({ length: limits.controlWaits }, () => f.client.wait('pending', id));
  await entered;
  await assert.rejects(f.client.wait('pending', id), { code: 'BUSY' });
  assert.equal((await f.client.get('pending')).candidate?.id, id);
  await f.client.cancel('pending', id);
  assert.ok((await Promise.all(pending)).every((outcome) => outcome.state === 'canceled'));
  assert.equal((await f.client.get('pending')).candidate, undefined);
});

test('shutdown returns cleanup failure before closing the control connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd shutdown '));
  const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
  const originalClose = runtime.close.bind(runtime);
  runtime.close = async () => { await originalClose(); throw new PreviewError('CLEANUP_INCOMPLETE', 'Unverified fixture resource.'); };
  const tokenFile = join(directory, 'private', 'token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  try {
    await assert.rejects(client.shutdown(), { code: 'CLEANUP_INCOMPLETE' });
    await assert.rejects(daemon.closed, { code: 'CLEANUP_INCOMPLETE' });
    await assert.rejects(client.list(), { code: 'DAEMON_UNAVAILABLE' });
  } finally {
    await client.close(); await assert.rejects(daemon.close(), { code: 'CLEANUP_INCOMPLETE' });
    await rm(directory, { recursive: true, force: true });
  }
});
