import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import { limits, type PreviewSpec, type PreviewStatus, type RuntimeOptions } from './contracts.js';
import { PreviewError } from './errors.js';

async function fixture(t: test.TestContext, authorize?: RuntimeOptions['authorize']) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'previewd runtime '));
  await fs.mkdir(path.join(directory, 'one'));
  await fs.mkdir(path.join(directory, 'two'));
  await fs.writeFile(path.join(directory, 'one/index.html'), '<h1>one</h1>');
  await fs.writeFile(path.join(directory, 'two/index.html'), '<h1>two</h1>');
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const spec = (name = 'page', version = 'one'): PreviewSpec => ({ name, type: 'static', directory: path.join(directory, version) });
  return { directory, runtime, spec };
}
async function ready(runtime: PreviewRuntime, status: PreviewStatus) {
  assert.ok(status.candidate);
  const result = await runtime.wait(status.name, status.candidate.id);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.ok(result.url);
  return result;
}
const code = (expected: string) => (error: unknown) => error instanceof PreviewError && error.code === expected;

function request(url: string, pathname: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const origin = new URL(url);
    const req = http.request({ hostname: origin.hostname, port: origin.port, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.once('end', () => resolve({ status: res.statusCode!, body }));
      res.once('error', reject);
    });
    req.once('error', reject); req.end();
  });
}

test('static replacement keeps its URL, failed candidates preserve the old page, and stop releases the listener', async (t) => {
  const { runtime, spec } = await fixture(t);
  const first = await ready(runtime, await runtime.start(spec()));
  assert.equal(await (await fetch(first.url!)).text(), '<h1>one</h1>');
  await assert.rejects(runtime.start(spec()), code('ALREADY_EXISTS'));
  const bad = await runtime.replace('page', { ...spec(), directory: '/does-not-exist' } as PreviewSpec);
  const failed = await runtime.wait('page', bad.candidate!.id);
  assert.equal(failed.state, 'failed');
  assert.equal((await runtime.get('page')).active?.id, first.id);
  assert.equal(await (await fetch(first.url!)).text(), '<h1>one</h1>');
  const second = await ready(runtime, await runtime.replace('page', spec('page', 'two')));
  assert.equal(second.url, first.url);
  assert.equal(await (await fetch(first.url!)).text(), '<h1>two</h1>');
  const stopped = await runtime.stop('page');
  assert.equal(stopped.busy, false);
  assert.equal(stopped.active, undefined);
  assert.equal(stopped.url, undefined);
  await assert.rejects(fetch(first.url!));
});

test('static file boundaries reject hidden paths, traversal, external/hidden symlinks and special files', async (t) => {
  const { runtime, spec, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'one/.env'), 'private');
  await fs.symlink('../two/index.html', path.join(directory, 'one/outside.html'));
  await fs.symlink('.env', path.join(directory, 'one/alias.txt'));
  await fs.writeFile(path.join(directory, 'one/app.js'), 'export const ok = true;');
  if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(directory, 'one/pipe')]);
  const page = await ready(runtime, await runtime.start({ ...spec(), spa: true } as PreviewSpec));
  for (const pathname of ['/.env', '/%2eenv', '/%2e%2e/two/index.html', '/%2E%2E%2ftwo/index.html', '/outside.html', '/alias.txt', '/%00', '/a%5cb']) {
    assert.equal((await request(page.url!, pathname)).status, 403, pathname);
  }
  assert.equal((await request(page.url!, '/route')).body, '<h1>one</h1>');
  assert.equal((await request(page.url!, '/missing.js')).status, 404);
  if (process.platform !== 'win32') assert.equal((await request(page.url!, '/pipe')).status, 404);
  assert.equal((await request(page.url!, '/app.js', 'HEAD')).body, '');
  assert.equal((await request(page.url!, '/', 'POST')).status, 405);
  assert.equal((await request(page.url!, '/%not-hex')).status, 400);
  await fs.writeFile(path.join(directory, 'one/index.html'), 'edited');
  assert.equal(await (await fetch(page.url!)).text(), 'edited');
});

test('source roots and spec validation apply to inspect and startup without executing native code', async (t) => {
  const { runtime, directory } = await fixture(t);
  const marker = path.join(directory, 'executed');
  const command: PreviewSpec = { name: 'denied', type: 'command', cwd: directory, command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], env: { PRIVATE_VALUE: 'do-not-show' } };
  const description = await runtime.inspect(command);
  assert.deepEqual(description.envKeys, ['PRIVATE_VALUE']);
  assert.equal(JSON.stringify(description).includes('do-not-show'), false);
  const started = await runtime.start(command);
  const result = await runtime.wait('denied', started.candidate!.id);
  assert.equal(result.error?.code, 'EXECUTION_DENIED');
  await assert.rejects(fs.stat(marker));
  assert.equal((await runtime.get('denied')).url, undefined);
  await assert.rejects(runtime.inspect({ name: 'outside', type: 'static', directory: os.tmpdir() }), code('SOURCE_DENIED'));
  await assert.rejects(runtime.start({ ...command, env: { PORT: '12' } }), code('INVALID_INPUT'));
  await assert.rejects(runtime.inspect({ name: 'remote', type: 'attach', url: 'http://example.com:1234/' }), code('INVALID_INPUT'));
  await assert.rejects(runtime.inspect({ name: 'query', type: 'attach', url: 'http://localhost:1234/?token=secret' }), code('INVALID_INPUT'));
  for (const readyPath of ['/bad path', '/bad\tpath', '/😀']) {
    await assert.rejects(runtime.start({ ...command, readyPath }), code('INVALID_INPUT'));
  }
  await assert.rejects(runtime.inspect({ name: 'invalid-host', type: 'attach', url: 'http://bad-.localhost:1234' }), code('INVALID_INPUT'));
  assert.equal((await runtime.inspect({ name: 'port-eighty', type: 'attach', url: 'http://127.0.0.1:80' })).spec.type, 'attach');
});

test('late authorization cannot resurrect a stopped attempt and callback mutation cannot change the effective source', async (t) => {
  let release!: (allowed: boolean) => void;
  let entered!: () => void;
  let approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
  const { runtime, spec, directory } = await fixture(t, ({ spec: inspected }) => {
    if (inspected.type === 'static') inspected.directory = path.join(directory, 'two');
    entered();
    return new Promise<boolean>((resolve) => { release = resolve; });
  });
  const input = spec();
  const started = await runtime.start(input);
  await approvalEntered;
  if (input.type === 'static') input.directory = path.join(directory, 'two');
  await assert.rejects(runtime.start(spec()), code('BUSY'));
  await runtime.stop('page');
  release(true);
  await delay(30);
  assert.equal((await runtime.get('page')).active, undefined);
  assert.equal((await runtime.wait('page', started.candidate!.id)).state, 'canceled');
  approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
  const next = await runtime.start(spec());
  await approvalEntered;
  release(true);
  const result = await ready(runtime, next);
  assert.equal(await (await fetch(result.url!)).text(), '<h1>one</h1>');
});

test('close does not wait forever for an authorization callback and permanently fences new work', async (t) => {
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  const { runtime, spec } = await fixture(t, () => { entered(); return new Promise<boolean>(() => {}); });
  await runtime.start(spec()); await pending;
  await Promise.race([runtime.close(), delay(1000).then(() => { throw new Error('close waited for an unresponsive authorization callback'); })]);
  await assert.rejects(runtime.start(spec()), code('CLOSED'));
});

test('cancel and wait target exact attempts; timeout and stale cancellation do not stop a newer candidate', async (t) => {
  let allow = false;
  const backend = http.createServer((_request, response) => { response.writeHead(allow ? 200 : 503); response.end('backend'); });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  const address = backend.address(); assert.ok(address && typeof address !== 'string');
  const { runtime, spec } = await fixture(t);
  const first = await ready(runtime, await runtime.start(spec()));
  const second = await runtime.replace('page', { name: 'page', type: 'attach', url: `http://127.0.0.1:${address.port}`, timeoutMs: 5000 });
  await assert.rejects(runtime.wait('page', second.candidate!.id, { timeoutMs: 5 }), code('TIMEOUT'));
  await assert.rejects(runtime.cancel('page', first.id), code('STALE_ATTEMPT'));
  assert.equal((await runtime.get('page')).candidate?.id, second.candidate!.id);
  assert.equal(await (await fetch(first.url!)).text(), '<h1>one</h1>');
  await runtime.cancel('page', second.candidate!.id);
  assert.equal((await runtime.wait('page', second.candidate!.id)).state, 'canceled');
  const third = await runtime.replace('page', { name: 'page', type: 'attach', url: `http://127.0.0.1:${address.port}` });
  allow = true;
  await ready(runtime, third);
  assert.equal(await (await fetch(first.url!)).text(), 'backend');
  await runtime.stop('page');
  assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'backend');
});

test('self attachment is rejected without disturbing the active preview', async (t) => {
  const { runtime, spec } = await fixture(t);
  const first = await ready(runtime, await runtime.start(spec()));
  const next = await runtime.replace('page', { name: 'page', type: 'attach', url: first.url! });
  assert.equal((await runtime.wait('page', next.candidate!.id)).error?.code, 'INVALID_INPUT');
  assert.equal(await (await fetch(first.url!)).text(), '<h1>one</h1>');
});

test('readiness rejects upgrades and stop cancels a server that never sends headers', { timeout: 5000 }, async (t) => {
  const sockets = new Set<Socket>();
  let upgrading = true;
  let received!: () => void;
  const backend = http.createServer((_request, response) => {
    received();
    if (upgrading) {
      response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' });
      response.flushHeaders();
    }
  });
  backend.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
  const address = backend.address(); assert.ok(address && typeof address !== 'string');
  const { runtime } = await fixture(t);
  const spec: PreviewSpec = { name: 'bad-health', type: 'attach', url: `http://127.0.0.1:${address.port}`, timeoutMs: 100 };
  received = () => {};
  const first = await runtime.start(spec);
  assert.equal((await runtime.wait(spec.name, first.candidate!.id)).error?.code, 'START_FAILED');
  upgrading = false;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const next = await runtime.start({ ...spec, timeoutMs: 5000 });
  await requestReceived;
  await runtime.stop(spec.name);
  assert.equal((await runtime.wait(spec.name, next.candidate!.id)).state, 'canceled');
  await delay(20);
  assert.equal(sockets.size, 0);
});

test('terminal history stays bounded while attempts remain separately addressable', async (t) => {
  const { runtime, directory } = await fixture(t);
  for (let n = 0; n < limits.terminalRecords + 3; n++) {
    const name = `denied-${n}`;
    const started = await runtime.start({ name, type: 'command', cwd: directory, command: [process.execPath, '-e', 'process.exit()'] });
    const result = await runtime.wait(name, started.candidate!.id);
    assert.equal(result.state, 'failed');
  }
  assert.equal((await runtime.list()).length, limits.terminalRecords);
  await assert.rejects(runtime.get('denied-0'), code('NOT_FOUND'));
  assert.equal((await runtime.get(`denied-${limits.terminalRecords + 2}`)).url, undefined);
});

test('native library flow verifies readiness, preserves a working server on replacement failure, and releases source untouched', { skip: process.platform !== 'darwin' }, async (t) => {
  const { runtime, directory } = await fixture(t, () => true);
  await fs.writeFile(path.join(directory, 'server.mjs'), `import http from 'node:http'; http.createServer((req,res)=>res.end(process.env.VALUE)).listen(Number(process.env.PORT),process.env.HOST);`);
  const command = (value: string): PreviewSpec => ({ name: 'native', type: 'command', cwd: directory, command: [process.execPath, 'server.mjs'], env: { VALUE: value } });
  const first = await ready(runtime, await runtime.start(command('alpha')));
  assert.equal(await (await fetch(first.url!)).text(), 'alpha');
  const bad = await runtime.replace('native', { ...command('bad'), command: [process.execPath, '-e', 'process.exit(2)'] } as PreviewSpec);
  assert.equal((await runtime.wait('native', bad.candidate!.id)).state, 'failed');
  assert.equal(await (await fetch(first.url!)).text(), 'alpha');
  const second = await ready(runtime, await runtime.replace('native', command('beta')));
  assert.equal(first.url, second.url);
  assert.equal(await (await fetch(first.url!)).text(), 'beta');
  await runtime.stop('native');
  await assert.rejects(fetch(first.url!));
  assert.ok((await fs.stat(path.join(directory, 'server.mjs'))).isFile());
});
