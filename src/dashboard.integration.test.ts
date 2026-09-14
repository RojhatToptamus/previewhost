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
  assert.ok(!(await shell.text()).includes(capability));
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
