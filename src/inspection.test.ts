import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { PreviewSpec } from './contracts.js';
import { createPreviewRuntime } from './runtime.js';
import { connectProject, projectOwnerDirectory } from './project.js';
import { Keystore } from './keystore.js';
import { pipePermissions } from './testSupport/permissions.js';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-inspect-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const method of ['get', 'status', 'unlock'] as const) t.mock.method(Keystore.prototype, method, () => { throw new Error('Inspection accessed the keystore.'); });
  return directory;
}

test('inspect reports missing commands without running them and allows job-prepared executables', { timeout: 30_000 }, async t => {
  let runtime: Awaited<ReturnType<typeof createPreviewRuntime>> | undefined;
  // Stop the copied executable before fixture cleanup, including when an assertion fails.
  t.after(() => runtime?.close());
  const directory = await fixture(t);
  runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true });
  const executable = process.platform === 'win32' ? 'prepared.exe' : 'prepared';
  await writeFile(join(directory, 'server.mjs'), `import http from 'node:http'; http.createServer((_req,res)=>res.end('prepared')).listen(Number(process.env.PORT),process.env.HOST);`);
  const spec: PreviewSpec = { name: 'prepared', type: 'environment', primary: 'web', services: {
    prepare: { type: 'job', cwd: directory, command: [process.execPath, '-e', `require('fs').copyFileSync(process.execPath, ${JSON.stringify(executable)})`] },
    web: { type: 'command', cwd: directory, command: [`./${executable}`, 'server.mjs'], dependsOn: ['prepare'] },
  } };
  const description = await runtime.inspect(spec);
  assert.deepEqual(description.prerequisites?.map(({ requirement, status, service }) => ({ requirement, status, service })), [
    { requirement: 'executable', status: 'unverified', service: 'web' },
  ]);
  assert.match(description.prerequisites![0].message, /prepare/);
  await assert.rejects(stat(join(directory, executable)), { code: 'ENOENT' });
  assert.deepEqual(await runtime.list(), []);
  const missing = await runtime.inspect({ name: 'missing', type: 'command', cwd: directory, command: ['./absent'] });
  assert.equal(missing.prerequisites?.[0].status, 'missing');
  const unknown = await runtime.inspect({ name: 'uninspected', type: 'command', cwd: directory, command: [join(tmpdir(), `outside-${randomUUID()}`)] });
  assert.equal(unknown.prerequisites?.[0].status, 'unverified');
  const customPath = await runtime.inspect({ name: 'path', type: 'command', cwd: directory, command: ['missing'], env: { PATH: 'FAKE_PRIVATE_PATH' } });
  assert.equal(customPath.prerequisites?.[0].status, 'unverified');
  assert.equal(JSON.stringify(customPath).includes('FAKE_PRIVATE_PATH'), false);
  await assert.rejects(runtime.inspect({ name: 'outside', type: 'command', cwd: tmpdir(), command: [process.execPath] }), { code: 'SOURCE_DENIED' });
  const started = await runtime.start(spec);
  const ready = await runtime.wait(spec.name, started.candidate!.id);
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(await (await fetch(ready.url!)).text(), 'prepared');
  assert.equal((await runtime.inspect(spec)).prerequisites, undefined);
});

test('inspect does not reauthorize a replaced source-root symlink', async t => {
  const directory = await fixture(t);
  const root = join(directory, 'approved');
  const outside = join(directory, 'unapproved');
  await mkdir(root); await mkdir(outside);
  const runtime = await createPreviewRuntime({ allowedRoots: [root] });
  t.after(() => runtime.close());
  const spec: PreviewSpec = { name: 'site', type: 'static', directory: root };
  assert.equal((await runtime.inspect(spec)).spec.type, 'static');
  await rename(root, join(directory, 'moved'));
  await symlink(outside, root, 'junction');
  await assert.rejects(runtime.inspect(spec), { code: 'SOURCE_DENIED' });
  assert.deepEqual(runtime.sourceRoots(), [root]);
  assert.deepEqual(await runtime.list(), []);
});

test('offline inspect checks the selected Docker endpoint using GET only, without creating an owner, data or keystore session', async t => {
  const directory = await fixture(t);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\previewhost-${randomUUID()}` : join(directory, 'docker.sock');
  const requests: string[] = [];
  let missing = true;
  let stalled = false;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (stalled) return;
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/v1.40/info') res.end(JSON.stringify({ ID: 'inspection-engine' }));
    else if (missing) res.writeHead(404).end('{}');
    else res.end(JSON.stringify({ Id: `sha256:${'a'.repeat(64)}` }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  if (process.platform === 'win32') pipePermissions(endpoint, false);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const dataDirectory = join(directory, 'private-data');
  const client = connectProject({ projectDirectory: directory, dataDirectory, dockerSocket: endpoint });
  t.after(() => client.close());
  const spec: PreviewSpec = { name: 'database', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory },
    db: { type: 'postgres' }, cache: { type: 'redis' },
  } };
  const description = await client.inspect(spec);
  assert.deepEqual(description.prerequisites?.map(finding => finding.requirement), ['image', 'image']);
  assert.deepEqual(requests, ['GET /v1.40/info', 'GET /v1.40/images/docker.io/library/postgres:17-alpine/json', 'GET /v1.40/images/docker.io/library/redis:7-alpine/json']);
  await assert.rejects(stat(dataDirectory), { code: 'ENOENT' });
  await assert.rejects(stat(projectOwnerDirectory(directory)), { code: 'ENOENT' });
  await assert.rejects(client.info(), { code: 'DAEMON_UNAVAILABLE' });
  missing = false;
  assert.equal((await client.inspect(spec)).prerequisites, undefined);
  stalled = true;
  assert.deepEqual((await client.inspect(spec)).prerequisites?.map(finding => finding.requirement), ['docker']);
  stalled = false;
  const count = requests.length;
  await client.inspect({ name: 'static', type: 'static', directory });
  assert.equal(requests.length, count, 'Static previews do not need Docker.');
  await writeFile(join(directory, 'ordinary-file'), 'not a socket');
  const unavailable = connectProject({ projectDirectory: directory, dockerSocket: join(directory, 'ordinary-file') });
  t.after(() => unavailable.close());
  assert.equal((await unavailable.inspect(spec)).prerequisites?.[0].requirement, 'docker');
  assert.equal(await readFile(join(directory, 'ordinary-file'), 'utf8'), 'not a socket');
  assert.deepEqual((await readdir(directory)).sort(), process.platform === 'win32' ? ['ordinary-file'] : ['docker.sock', 'ordinary-file']);
});
