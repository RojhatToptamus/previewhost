import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startDashboard } from './dashboard.js';
import { startDaemon } from './daemon.js';
import { createPreviewRuntime } from './runtime.js';
import { discoverProjectOwners } from './project.js';
import { connectPreviewDaemon } from './client.js';
import type { PreviewStatus } from './contracts.js';

test('dashboard authenticates browser access, discovers isolated owners, and controls real previews without owning their lifetime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-dashboard-'));
  const records = join(directory, 'owners');
  await mkdir(records, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = [];
  for (const name of ['worktree-one', 'worktree-two']) {
    const projectDirectory = join(directory, name);
    await mkdir(projectDirectory);
    await writeFile(join(projectDirectory, 'index.html'), name);
    const id = createHash('sha256').update(projectDirectory).digest('hex');
    const tokenFile = join(records, id, 'token');
    const runtime = await createPreviewRuntime({ allowedRoots: [projectDirectory] });
    const owner = { projectDirectory, pid: process.pid, allowedRoots: [projectDirectory], allowExec: false, inputKeys: [], secretIds: [] };
    const daemon = await startDaemon({ runtime, owner, tokenFile, port: 0 });
    t.after(() => daemon.close());
    await writeFile(join(records, id, 'connection.json'), JSON.stringify({ endpoint: daemon.endpoint, pid: process.pid, projectDirectory }), { mode: 0o600 });
    const status = await runtime.start({ name: 'app', type: 'static', directory: projectDirectory });
    const result = await runtime.wait('app', status.candidate!.id);
    assert.equal(result.state, 'ready');
    fixtures.push({ id, runtime, daemon, tokenFile, projectDirectory, url: result.url! });
  }
  let launch = '';
  const dashboard = await startDashboard({ discover: () => discoverProjectOwners(records), openBrowser: async url => { launch = url; } });
  t.after(() => dashboard.close());
  await dashboard.open();
  const capability = new URL(launch).hash.slice(1);
  const api = async (body: object, headers = {}) => {
    const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
      'content-type': 'application/json', origin: dashboard.endpoint, authorization: 'Bearer ' + capability, ...headers,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { result: any; error?: { code: string } } };
  };
  const shell = await fetch(dashboard.endpoint);
  assert.match(shell.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(shell.headers.get('content-security-policy')!, /font-src 'self';/);
  const html = await shell.text();
  assert.ok(!html.includes(capability));
  assert.match(shell.headers.get('content-security-policy')!, /script-src 'self';/);
  for (const file of ['dashboard.js', 'dashboard.css']) {
    assert.ok(html.includes('/' + file));
    const asset = await fetch(`${dashboard.endpoint}/${file}`);
    assert.equal(asset.status, 200);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(new URL(`./dashboard/${file}`, import.meta.url)));
    assert.equal((await fetch(`${dashboard.endpoint}/${file}`, { headers: { origin: 'http://evil.example' } })).status, 401);
  }
  for (const file of ['geist.woff2', 'geist-mono.woff2']) {
    const font = await fetch(`${dashboard.endpoint}/fonts/${file}`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal(font.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual(Buffer.from(await font.arrayBuffer()), await readFile(new URL(`./fonts/${file}`, import.meta.url)));
    assert.equal((await fetch(`${dashboard.endpoint}/fonts/${file}`, { headers: { origin: 'http://evil.example' } })).status, 401);
  }
  assert.equal((await fetch(`${dashboard.endpoint}/fonts/LICENSE.txt`)).status, 401);
  assert.equal((await api({ action: 'list' }, { origin: 'http://evil.example' })).status, 401);
  assert.equal((await api({ action: 'list' }, { authorization: 'Bearer invalid' })).status, 401);
  assert.equal(await new Promise<number>(resolve => {
    const req = request(dashboard.endpoint, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
  }), 401);
  assert.equal((await api({ action: 'shutdown', owner: fixtures[0].id })).body.error?.code, 'INVALID_INPUT');
  const list = await api({ action: 'list' });
  assert.equal(list.body.result.length, 2);
  assert.ok(!JSON.stringify(list.body).includes('tokenFile'));
  assert.ok(!JSON.stringify(list.body).includes(capability));
  const first = fixtures[0];
  await writeFile(join(first.projectDirectory, 'preview.yml'), 'name: app\nservices: [\n');
  const invalidConfig = (await api({ action: 'list' })).body.result.find((owner: any) => owner.id === first.id);
  assert.equal(invalidConfig.configuration.error.code, 'INVALID_INPUT');
  assert.match(invalidConfig.configuration.error.message, /line 3/);
  assert.equal(await (await fetch(first.url)).text(), 'worktree-one');
  await rm(join(first.projectDirectory, 'preview.yml'));
  const recoveredConfig = (await api({ action: 'list' })).body.result.find((owner: any) => owner.id === first.id);
  assert.equal(recoveredConfig.configuration, undefined);
  const before = await first.runtime.get('app');
  const expected = { active: before.active!.id, candidate: null, latest: before.latest!.id };
  assert.equal((await api({ action: 'saveConfiguration', owner: first.id, name: 'app', attemptId: before.active!.id, projectDirectory: directory })).body.error?.code, 'INVALID_INPUT');
  const saved = await api({ action: 'saveConfiguration', owner: first.id, name: 'app', attemptId: before.active!.id });
  assert.deepEqual(saved.body.result, { file: join(await realpath(first.projectDirectory), 'preview.yml'), externalSources: [] });
  assert.match(await readFile(saved.body.result.file, 'utf8'), /directory: ./);
  assert.equal((await api({ action: 'saveConfiguration', owner: first.id, name: 'app', attemptId: before.active!.id })).body.error?.code, 'ALREADY_EXISTS');
  assert.equal((await api({ action: 'stop', owner: first.id, name: 'app', expected: { ...expected, active: 'stale' } })).body.error?.code, 'STALE_ATTEMPT');
  assert.equal(await (await fetch(first.url)).text(), 'worktree-one');
  const stopped = await api({ action: 'stop', owner: first.id, name: 'app', expected });
  assert.equal(stopped.body.result.latest.state, 'stopped');
  assert.equal(await (await fetch(fixtures[1].url)).text(), 'worktree-two');
  const started = await api({ action: 'startAgain', owner: first.id, name: 'app', attemptId: stopped.body.result.latest.id });
  const result = await first.runtime.wait('app', (started.body.result as PreviewStatus).candidate!.id);
  assert.equal(result.state, 'ready');
  await dashboard.close();
  assert.equal(await (await fetch(result.url!)).text(), 'worktree-one');
  const ownerClient = connectPreviewDaemon({ endpoint: first.daemon.endpoint, tokenFile: first.tokenFile });
  t.after(() => ownerClient.close());
  assert.deepEqual(await ownerClient.secretsList(), []);
});

test('discovery rejects unsafe records without following them or hiding other owners', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'a'.repeat(64);
  await symlink('/tmp', join(directory, id));
  const owners = await discoverProjectOwners(directory);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].error?.code, 'UNAUTHORIZED');
  assert.equal(owners[0].connection, undefined);
});

test('a hung owner is bounded without blocking healthy-owner results', { timeout: 10_000 }, async t => {
  const { createServer } = await import('node:http');
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-hung-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const hung = createServer(() => {});
  await new Promise<void>(resolve => hung.listen(0, '127.0.0.1', resolve));
  t.after(() => { hung.close(); hung.closeAllConnections(); });
  const port = (hung.address() as { port: number }).port;
  const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
  const healthyToken = join(directory, 'healthy', 'token');
  const healthy = await startDaemon({ runtime, port: 0, tokenFile: healthyToken, owner: { projectDirectory: directory, pid: process.pid, allowedRoots: [directory], allowExec: false, inputKeys: [], secretIds: [] } });
  t.after(() => healthy.close());
  let launch = '';
  const dashboard = await startDashboard({
    discover: async () => [{ id: 'b'.repeat(64), tokenFile, connection: { endpoint: `http://127.0.0.1:${port}`, pid: process.pid, projectDirectory: directory } }, { id: 'c'.repeat(64), tokenFile: healthyToken, connection: { endpoint: healthy.endpoint, pid: process.pid, projectDirectory: directory } }],
    openBrowser: async url => { launch = url; },
  });
  t.after(() => dashboard.close()); await dashboard.open();
  const start = performance.now();
  const res = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: { 'content-type': 'application/json', origin: dashboard.endpoint, authorization: 'Bearer ' + new URL(launch).hash.slice(1) }, body: JSON.stringify({ action: 'list' }) });
  const result = await res.json() as { result: Array<{ error?: { code: string }; previews?: PreviewStatus[] }> };
  assert.equal(result.result[0].error?.code, 'TIMEOUT');
  assert.deepEqual(result.result[1].previews, []);
  assert.equal(result.result[1].error, undefined);
  assert.ok(performance.now() - start < 6000);
});

test('Secret Manager updates existing references through the authenticated dashboard without reading values or changing approvals', { skip: process.platform !== 'darwin', timeout: 15_000 }, async t => {
  const { testKeychain } = await import('./testSupport/keychain.js');
  const fixture = await testKeychain(t);
  const opened: string[] = [];
  const dashboard = await startDashboard({
    discover: async () => { throw new Error('Secret Manager must not need a project owner.'); },
    openBrowser: async url => { opened.push(url); },
  });
  t.after(() => dashboard.close());
  await dashboard.open();
  const token = new URL(opened.pop()!).hash.slice(1);
  const responses: string[] = [];
  const post = async (body: object, authorization = token, origin = dashboard.endpoint) => {
    const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
      'content-type': 'application/json', origin, authorization: 'Bearer ' + authorization,
    }, body: JSON.stringify(body) });
    const text = await response.text(); responses.push(text);
    return { status: response.status, ...JSON.parse(text) };
  };
  const list = () => post({ action: 'listSecrets' });
  const update = (id: string, value: string) => post({ action: 'updateSecret', id, value });
  assert.deepEqual((await list()).result, { ids: [], truncated: false });
  await fixture.store.add('user', 'shop/dev/api', 'FAKE_original');
  await fixture.store.add('user', 'another/dev/api', 'FAKE_other');
  await fixture.store.add('database', 'private-database', 'FAKE_internal');
  await fixture.store.add('migration', 'private-migration', 'FAKE_internal');
  assert.deepEqual((await list()).result, { ids: ['another/dev/api', 'shop/dev/api'], truncated: false });
  const change = { action: 'updateSecret', id: 'shop/dev/api', value: 'FAKE_forbidden' };
  assert.equal((await post(change, 'invalid')).status, 401);
  assert.equal((await post(change, token, 'http://evil.example')).status, 401);
  assert.equal((await update('missing', 'FAKE_missing')).error.code, 'SECRET_REQUIRED');
  assert.equal((await update('private-database', 'FAKE_internal')).error.code, 'SECRET_REQUIRED');
  assert.equal((await update('invalid space', 'FAKE_invalid')).error.code, 'INVALID_INPUT');
  for (const value of ['', 'FAKE_\0', '🙂'.repeat(1025)]) {
    assert.equal((await update('shop/dev/api', value)).error.code, 'INVALID_INPUT');
  }
  assert.equal((await post({ ...change, namespace: 'database' })).error.code, 'INVALID_INPUT');
  assert.equal(await fixture.store.get('user', 'shop/dev/api'), 'FAKE_original');
  const saved = await update('shop/dev/api', 'FAKE_replacement\nline two');
  assert.deepEqual(saved.result, { id: 'shop/dev/api' });
  assert.equal(await fixture.store.get('user', 'shop/dev/api'), 'FAKE_replacement\nline two');
  assert.equal(await fixture.store.get('user', 'another/dev/api'), 'FAKE_other');
  const writes = await Promise.all([
    update('shop/dev/api', 'FAKE_shop'), update('another/dev/api', 'FAKE_another'),
  ]);
  assert.ok(writes.every(result => result.status === 200));
  assert.equal(await fixture.store.get('user', 'shop/dev/api'), 'FAKE_shop');
  assert.equal(await fixture.store.get('user', 'another/dev/api'), 'FAKE_another');
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], authorize: () => true });
  t.after(() => runtime.close());
  const description = await runtime.inspect({ name: 'shop', type: 'command', cwd: fixture.directory, command: [process.execPath, 'app.mjs'], env: { API_SECRET: { secret: 'shop/dev/api' } } });
  assert.equal(description.secrets![0].selected, false);
  await fixture.store.remove('user', 'shop/dev/api');
  assert.equal((await update('shop/dev/api', 'FAKE_not_recreated')).error.code, 'SECRET_REQUIRED');
  assert.equal(await fixture.store.has('user', 'shop/dev/api'), false);
  assert.ok(responses.every(text => !text.includes('FAKE_') && !text.includes(token)));
  assert.equal(opened.length, 0, 'Editing never launches another browser page');
  await fixture.control('lock');
  assert.equal((await list()).error.code, 'SECRET_STORE_UNAVAILABLE');
  await fixture.control('unlock');
  assert.deepEqual((await list()).result.ids, ['another/dev/api']);
  await dashboard.close();
  await assert.rejects(update('another/dev/api', 'FAKE_after_close'));
  assert.equal(await fixture.store.get('user', 'another/dev/api'), 'FAKE_another');
});

test('dashboard shutdown cancels and joins an in-flight Keychain update', async t => {
  const { keychain } = await import('./keychain.js');
  let launch = '';
  const dashboard = await startDashboard({ openBrowser: async url => { launch = url; } });
  t.after(() => dashboard.close());
  await dashboard.open();
  let enter!: () => void; let cancel!: () => void; let complete!: (value: boolean) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const canceled = new Promise<void>(resolve => { cancel = resolve; });
  const completed = new Promise<boolean>(resolve => { complete = resolve; });
  t.mock.method(keychain, 'update', (...args: Parameters<typeof keychain.update>) => {
    args[3]!.signal!.addEventListener('abort', cancel, { once: true });
    enter();
    return completed;
  });
  const request = fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
    origin: dashboard.endpoint, authorization: 'Bearer ' + new URL(launch).hash.slice(1), 'content-type': 'application/json',
  }, body: JSON.stringify({ action: 'updateSecret', id: 'shop/api', value: 'FAKE_inflight' }) }).catch(() => undefined);
  await entered;
  let closed = false;
  const closing = dashboard.close().then(() => { closed = true; });
  await canceled;
  assert.equal(closed, false);
  complete(true);
  await closing; await request;
  assert.equal(closed, true);
});
