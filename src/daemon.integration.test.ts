import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { makePrivateDirectory } from './private-files.js';
import { publicAccess } from './testSupport/permissions.js';
import { loadPreviewSpec } from './config.js';

async function fixture(t: TestContext, authorize?: RuntimeOptions['authorize']) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost transport '));
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

test('configuration saving requires owner project metadata', async t => {
  const f = await fixture(t);
  const status = await f.client.start({ name: 'page', type: 'static', directory: f.directory });
  await f.client.wait('page', status.candidate!.id);
  await assert.rejects(f.client.saveConfiguration('page', status.candidate!.id), { code: 'INVALID_INPUT' });
  await assert.rejects(f.client.allowSources([f.directory]), { code: 'EXECUTION_DENIED' });
  await assert.rejects(readFile(join(f.directory, 'preview.yaml')), { code: 'ENOENT' });
});

test('start and replace transport preserve file origin and stale slot guards', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'index.html'), 'guarded transport preview');
  const spec = { name: 'page', type: 'static' as const, directory: f.directory };
  const sourceFile = join(f.directory, 'custom.yaml');
  const first = await f.client.start(spec, { sourceFile, expected: { active: null, candidate: null, latest: null } });
  await f.client.wait('page', first.candidate!.id);
  assert.equal((await f.client.describe('page', first.candidate!.id)).sourceFile, sourceFile);
  const replacementFile = join(f.directory, 'replacement.json');
  const replacement = await f.client.replace('page', spec, { sourceFile: replacementFile,
    expected: { active: first.candidate!.id, candidate: null, latest: first.candidate!.id } });
  await f.client.wait('page', replacement.candidate!.id);
  assert.equal((await f.client.describe('page', replacement.candidate!.id)).sourceFile, replacementFile);
  await assert.rejects(f.client.replace('page', spec, { expected: {
    active: first.candidate!.id, candidate: null, latest: first.candidate!.id,
  } }), { code: 'STALE_ATTEMPT' });
  const stopped = await f.client.stop('page');
  const again = await f.client.startAgain('page', stopped.latest!.id);
  await f.client.wait('page', again.candidate!.id);
  assert.equal((await f.client.describe('page', again.candidate!.id)).sourceFile, replacementFile);
  await f.client.stop('page');
  await assert.rejects(f.client.start(spec, { expected: { active: null, candidate: null, latest: first.candidate!.id } }), { code: 'STALE_ATTEMPT' });
  const direct = await f.client.start(spec);
  await f.client.wait('page', direct.candidate!.id);
  assert.equal((await f.client.describe('page', direct.candidate!.id)).sourceFile, undefined);
});

test('binding edits preserve undisclosed values through review, private setup, apply and save', async t => {
  let secretReview: Extract<Parameters<NonNullable<RuntimeOptions['authorize']>>[0], { operation: 'secrets-setup' }> | undefined;
  const f = await fixture(t, request => {
    if (request.operation === 'secrets-setup') { secretReview = request; return false; }
    return request.operation === 'start' || request.operation === 'replace';
  });
  await writeFile(join(f.directory, 'server.mjs'), `import http from 'node:http'; if(process.env.CHANGE==='fail')process.exit(2); http.createServer((req,res)=>res.end(JSON.stringify([process.env.KEEP,process.env.CHANGE,process.env.REMOVE,process.env.NEW]))).listen(Number(process.env.PORT),process.env.HOST);`);
  const first = await f.client.start({ name: 'edited', type: 'command', cwd: f.directory,
    command: [process.execPath, 'server.mjs'], env: { KEEP: 'retained-fixture', CHANGE: 'before', REMOVE: 'drop' } }, { sourceFile: join(f.directory, 'original.yaml') });
  const ready = await f.client.wait('edited', first.candidate!.id);
  assert.equal(ready.state, 'ready');
  const changes = [{ key: 'CHANGE', value: 'after' }, { key: 'REMOVE', value: null }, { key: 'NEW', value: 'added' }];
  const inspection = await f.client.configureBindings('edited', ready.id, changes, { operation: 'inspect' });
  if (!('bindings' in inspection)) throw new Error('Expected configuration inspection');
  assert.deepEqual(inspection.bindings.map(row => row.key).sort(), ['CHANGE', 'KEEP', 'NEW']);
  assert.ok(inspection.bindings.every(row => row.value === null));
  assert.ok(!JSON.stringify(inspection).includes('retained-fixture'));
  assert.deepEqual(await (await fetch(ready.url!)).json(), ['retained-fixture', 'before', 'drop', null]);
  await assert.rejects(f.client.configureBindings('edited', ready.id, changes, { operation: 'secrets' }), { code: 'EXECUTION_DENIED' });
  assert.ok(secretReview?.spec?.type === 'command');
  assert.deepEqual(secretReview.spec.env, { KEEP: 'retained-fixture', CHANGE: 'after', NEW: 'added' });
  const expected = { active: ready.id, candidate: null, latest: ready.id };
  const applied = await f.client.configureBindings('edited', ready.id, changes, { operation: 'apply', expected });
  if (!('busy' in applied)) throw new Error('Expected preview status');
  const updated = await f.client.wait('edited', applied.candidate!.id);
  assert.equal(updated.state, 'ready');
  assert.equal(updated.url, ready.url);
  assert.equal((await f.client.describe('edited', updated.id)).sourceFile, undefined);
  assert.deepEqual(await (await fetch(ready.url!)).json(), ['retained-fixture', 'after', null, 'added']);
  await assert.rejects(f.client.configureBindings('edited', ready.id, [{ key: 'KEEP', value: null }], { operation: 'apply', expected }), { code: 'STALE_ATTEMPT' });
  const failing = await f.client.configureBindings('edited', updated.id, [{ key: 'CHANGE', value: 'fail' }], {
    operation: 'apply', expected: { active: updated.id, candidate: null, latest: updated.id },
  });
  const failed = await f.client.wait('edited', failing.candidate!.id);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(await (await fetch(ready.url!)).json(), ['retained-fixture', 'after', null, 'added']);
  const fixed = await f.client.configureBindings('edited', failed.id, [{ key: 'CHANGE', value: 'fixed' }], {
    operation: 'apply', expected: { active: updated.id, candidate: null, latest: failed.id },
  });
  const recovered = await f.client.wait('edited', fixed.candidate!.id);
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.url, ready.url);
  assert.deepEqual(await (await fetch(ready.url!)).json(), ['retained-fixture', 'fixed', null, 'added']);
  await assert.rejects(f.client.configureBindings('edited', recovered.id, [], { operation: 'save' }), { code: 'INVALID_INPUT' });
  const saved = await f.runtime.configureBindings('edited', recovered.id, [{ key: 'CHANGE', value: 'saved-only' }], { operation: 'save' }, { projectDirectory: f.directory });
  if (!('file' in saved)) throw new Error('Expected saved configuration');
  const declaration = await loadPreviewSpec(saved.file);
  assert.ok(declaration.type === 'command');
  assert.deepEqual(declaration.env, { KEEP: 'retained-fixture', CHANGE: 'saved-only', NEW: 'added' });
  assert.deepEqual(await (await fetch(ready.url!)).json(), ['retained-fixture', 'fixed', null, 'added']);
  await assert.rejects(f.runtime.configureBindings('edited', recovered.id, [], { operation: 'save' }, { projectDirectory: f.directory }), { code: 'ALREADY_EXISTS' });
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
  if (process.platform !== 'win32') { // Windows has no filesystem FIFOs.
    const fifo = join(f.directory, 'private', 'fifo');
    await promisify(execFile)('/usr/bin/mkfifo', [fifo]);
    const fifoClient = connectPreviewDaemon({ endpoint: f.daemon.endpoint, tokenFile: fifo });
    t.after(() => fifoClient.close());
    await assert.rejects(fifoClient.list(), { code: 'UNAUTHORIZED' });
  }
  const linked = join(f.directory, 'private', 'linked-token');
  await symlink(f.tokenFile, linked);
  const linkedClient = connectPreviewDaemon({ endpoint: f.daemon.endpoint, tokenFile: linked });
  t.after(() => linkedClient.close());
  await assert.rejects(linkedClient.list(), { code: 'UNAUTHORIZED' });
  await publicAccess(f.tokenFile, true);
  await assert.rejects(f.client.list(), { code: 'UNAUTHORIZED' });
  await publicAccess(f.tokenFile, false);
  await publicAccess(join(f.directory, 'private'), true);
  await assert.rejects(f.client.list(), { code: 'UNAUTHORIZED' });
  await publicAccess(join(f.directory, 'private'), false);
  const badDirectory = join(f.directory, 'broad');
  makePrivateDirectory(badDirectory);
  await publicAccess(badDirectory, true);
  await assert.rejects(startDaemon({ runtime: f.runtime, tokenFile: join(badDirectory, 'token'), port: 0 }), { code: 'UNAUTHORIZED' });
  assert.throws(() => connectPreviewDaemon({ endpoint: 'http://example.com:9400' }), { code: 'INVALID_INPUT' });
  assert.throws(() => connectPreviewDaemon({ endpoint: 'http://token@127.0.0.1:9400' }), { code: 'INVALID_INPUT' });
  assert.throws(() => connectPreviewDaemon({ endpoint: 'http://127.0.0.1' }), { code: 'INVALID_INPUT' });
  assert.doesNotThrow(() => connectPreviewDaemon({ endpoint: 'http://127.0.0.1:80' }));
});

test('daemon token directories are excluded from existing and future static previews, including aliases', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost private source '));
  const privateDirectory = join(directory, 'private');
  makePrivateDirectory(privateDirectory);
  await writeFile(join(directory, 'index.html'), 'public');
  await writeFile(join(privateDirectory, 'index.html'), 'private');
  const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  t.after(async () => { await (daemon?.close() ?? runtime.close()); await rm(directory, { recursive: true, force: true }); });
  const before = await runtime.start({ name: 'before', type: 'static', directory: privateDirectory });
  const existing = await runtime.wait('before', before.candidate!.id);
  assert.equal(existing.state, 'ready');
  daemon = await startDaemon({ runtime, port: 0, tokenFile: join(privateDirectory, 'token') });
  await symlink(privateDirectory, join(directory, 'alias'));
  await symlink(join(privateDirectory, 'token'), join(directory, 'token-alias'));
  const started = await runtime.start({ name: 'site', type: 'environment', primary: 'web',
    services: { web: { type: 'static', directory } } });
  const ready = await runtime.wait('site', started.candidate!.id);
  assert.equal(ready.state, 'ready');
  assert.equal(await (await fetch(ready.url!)).text(), 'public');
  for (const path of ['/private/token', '/alias/token', '/token-alias']) {
    assert.equal((await fetch(new URL(path, ready.url))).status, 403);
  }
  assert.equal((await fetch(existing.url!)).status, 403);
  await assert.rejects(runtime.inspect({ name: 'private', type: 'static', directory: privateDirectory }), { code: 'SOURCE_DENIED' });
  await assert.rejects(runtime.inspect({ name: 'alias', type: 'static', directory: join(directory, 'alias') }), { code: 'SOURCE_DENIED' });
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
  const directory = await mkdtemp(join(tmpdir(), 'previewhost shutdown '));
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
