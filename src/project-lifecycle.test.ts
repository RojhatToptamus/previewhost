import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createPreviewRuntime } from './runtime.js';
import { connectPreviewDaemon } from './client.js';
import { startDaemon } from './daemon.js';
import { startDashboard } from './dashboard.js';
import { reviewStaleProject, removeStaleProject, writeProjectRecord, connectProject, deleteOfflineData, discoverProjectOwners, lockProject, offlinePreviews, projectOwnerDirectory, readProjectRecord, removeOfflineProject } from './project.js';
import { createDataOwner } from './data.js';
import { SecretSetup } from './secrets-setup.js';
import { testKeystore } from './testSupport/keystore.js';
import { traceStep } from './testSupport/diagnosis.js';
import type { PreviewSpec } from './contracts.js';

const execute = promisify(execFile);
const mac = { skip: process.platform !== 'darwin' };

test('entry removal preserves neighbors and refuses active, stale, and private-setup operations', mac, async t => {
  const fixture = await testKeystore(t);
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], authorize: () => true });
  const tokenFile = join(fixture.directory, 'control/token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  let form = '';
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { form = url; });
  try {
    await assert.rejects(client.remove('missing'), { code: 'NOT_FOUND' });
    await writeFile(join(fixture.directory, 'index.html'), 'neighbor');
    const spec: PreviewSpec = { name: 'neighbor', type: 'static', directory: fixture.directory };
    const ready = await runtime.wait(spec.name, (await runtime.start(spec)).candidate!.id);
    const secretSpec: PreviewSpec = { name: 'pending', type: 'command', cwd: fixture.directory,
      command: [process.execPath, '-e', ''], env: { TOKEN: { secret: 'disposable/project/api' } } };
    await client.secretsSetup(secretSpec);
    await assert.rejects(client.remove('pending'), { code: 'BUSY' });
    const response = await fetch(daemon.endpoint + '/secrets/cancel', { method: 'POST', headers: {
      origin: daemon.endpoint, authorization: 'Bearer ' + new URL(form).hash.slice(1), 'content-type': 'application/json',
    }, body: '{}' });
    assert.equal(response.status, 200);
    await client.remove('pending');
    assert.deepEqual(await client.secretsList(), []);
    await assert.rejects(client.remove('neighbor', ready.id), { code: 'BUSY' });
    await client.stop('neighbor');
    await assert.rejects(client.remove('neighbor', 'stale'), { code: 'STALE_ATTEMPT' });
    const restarting = await runtime.start(spec);
    await assert.rejects(client.remove('neighbor', ready.id));
    const next = await runtime.wait(spec.name, restarting.candidate!.id);
    assert.equal(await (await fetch(next.url!)).text(), 'neighbor');
    await client.stop('neighbor'); await client.remove('neighbor', next.id);
    assert.deepEqual(await client.list(), []);
    assert.equal(await readFile(join(fixture.directory, 'index.html'), 'utf8'), 'neighbor');
  } finally { await client.close(); await daemon.close(); }
});

test('an empty owner can clear canceled secret editing without deleting the saved reference', mac, async t => {
  const fixture = await testKeystore(t);
  await fixture.store.add('user', 'disposable/shared', 'FAKE');
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['disposable/shared'], authorize: () => true });
  const tokenFile = join(fixture.directory, 'control/token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  let form = '';
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { form = url; });
  try {
    await client.secretsEdit('disposable/shared');
    await assert.rejects(client.remove(), { code: 'BUSY' });
    await fetch(daemon.endpoint + '/secrets/cancel', { method: 'POST', headers: {
      origin: daemon.endpoint, authorization: 'Bearer ' + new URL(form).hash.slice(1), 'content-type': 'application/json',
    }, body: '{}' });
    await client.remove();
    assert.deepEqual(await client.secretsList(), []);
    assert.equal(await fixture.store.has('user', 'disposable/shared'), true);
  } finally { await client.close(); await daemon.close(); }
});

test('CLI manages a deleted source and removing the last entry retires only its idle owner', mac, async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-deleted-source-')));
  const client = connectProject({ projectDirectory: project, allowExec: true });
  const cli = resolve('dist/cli.js');
  try {
    const started = await client.start({ name: 'app', type: 'command', cwd: project,
      command: [process.execPath, '-e', "require('http').createServer((q,r)=>r.end('alive')).listen(+process.env.PORT,process.env.HOST)"] });
    const ready = await client.wait('app', started.candidate!.id);
    assert.equal(ready.state, 'ready');
    await rm(project, { recursive: true });
    assert.equal(await (await fetch(ready.url!)).text(), 'alive');
    await execute(process.execPath, [cli, 'stop', 'app', '--project', project]);
    const stopped = (await client.get('app')).latest!;
    assert.equal(stopped.state, 'stopped');
    await execute(process.execPath, [cli, 'remove', 'app', '--project', project]);
    await assert.rejects(client.list());
  } finally {
    await client.shutdown().catch(() => {}); await client.close();
    await rm(projectOwnerDirectory(project), { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('discovery and bounded dashboard pages retain all 145 records, including unavailable owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-many-projects-'));
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    for (let i = 0; i < 145; i++) {
      const projectDirectory = join(directory, 'source-' + i);
      const id = createHash('sha256').update(projectDirectory).digest('hex');
      await mkdir(join(directory, id), { mode: 0o700 });
      await writeFile(join(directory, id, 'connection.json'), JSON.stringify({ projectDirectory, pid: process.pid, endpoint: 'http://127.0.0.1:1' }), { mode: 0o600 });
      await writeFile(join(directory, id, 'token'), 'a'.repeat(64), { mode: 0o600 });
    }
    const records = await discoverProjectOwners(directory);
    assert.equal(records.length, 145);
    if (process.platform === 'darwin') {
      const unavailable = join(directory, records[0].id);
      await assert.rejects(removeOfflineProject(unavailable), { code: 'STALE_ATTEMPT' });
      await assert.rejects(deleteOfflineData(unavailable, 'app', {}), { code: 'STALE_ATTEMPT' });
      assert.ok((await readProjectRecord(unavailable))?.endpoint);
    }
    let launch = '';
    dashboard = await startDashboard({ discover: () => discoverProjectOwners(directory), openBrowser: async url => { launch = url; } });
    await dashboard.open();
    let after: string | undefined;
    const ids: string[] = [];
    do {
      const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
        origin: dashboard.endpoint, authorization: 'Bearer ' + new URL(launch).hash.slice(1), 'content-type': 'application/json',
      }, body: JSON.stringify({ action: 'list', after }) });
      const { result } = await response.json() as { result: { owners: Array<{ id: string; error?: unknown }>; next?: string } };
      assert.ok(result.owners.length <= 16);
      assert.ok(result.owners.every(owner => owner.error));
      ids.push(...result.owners.map(owner => owner.id)); after = result.next;
    } while (after);
    assert.equal(ids.length, 145); assert.equal(new Set(ids).size, 145);
  } finally { await dashboard?.close(); await rm(directory, { recursive: true, force: true }); }
});

const dockerSocket = process.env.PREVIEWHOST_TEST_DOCKER_SOCKET;
test('offline projects keep real PostgreSQL data discoverable and delete only explicitly confirmed resources', {
  skip: process.platform !== 'darwin' || !dockerSocket, timeout: 60_000,
}, async t => {
  const fixture = await traceStep('offline.fixture', () => testKeystore(t));
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-offline-project-')));
  const ownerDirectory = projectOwnerDirectory(project);
  const dataDirectory = join(fixture.directory, 'retained');
  const hook = join(fixture.directory, 'preload.mjs');
  await writeFile(hook, fixture.installSource.replaceAll('/.local/test-build/', '/dist/'));
  await fixture.store.add('user', 'disposable/shared/api', 'FAKE_SHARED');
  const pg = JSON.stringify(import.meta.resolve('pg'));
  const spec: PreviewSpec = { name: 'app', type: 'environment', primary: 'web', services: {
    db: { type: 'postgres' },
    migrate: { type: 'job', cwd: project, dependsOn: ['db'], env: { DATABASE_URL: { service: 'db' } }, command: [process.execPath, '-e',
      `import(${pg}).then(async({Client})=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('CREATE TABLE IF NOT EXISTS marker(id int primary key); INSERT INTO marker VALUES(1) ON CONFLICT DO NOTHING');await c.end()}).catch(()=>process.exit(1))`] },
    web: { type: 'command', cwd: project, dependsOn: ['migrate'], env: { DATABASE_URL: { service: 'db' } }, command: [process.execPath, '-e',
      `import(${pg}).then(async({Client})=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();require('http').createServer(async(q,r)=>{try{r.end(String((await c.query('SELECT count(*) FROM marker')).rows[0].count))}catch{r.writeHead(500);r.end('failed')}}).listen(+process.env.PORT,process.env.HOST)})`] },
  } };
  const file = join(project, 'spec.json'); await writeFile(file, JSON.stringify(spec));
  const client = connectProject({ projectDirectory: project });
  const authorized = connectProject({ projectDirectory: project, allowExec: true });
  try {
    const args = [resolve('dist/cli.js'), 'start', '--project', project, '--file', file, '--allow-exec'];
    const first = JSON.parse((await traceStep('offline.first-start', () => execute(process.execPath, [...args, '--data-dir', dataDirectory, '--docker-socket', dockerSocket!], {
      env: { ...process.env, NODE_OPTIONS: `--import=${hook}` }, timeout: 30_000,
    }))).stdout);
    await traceStep('offline.first-query', async () => { assert.equal(await (await fetch(first.url)).text(), '1'); });
    await traceStep('offline.active-remove-denial', () => assert.rejects(client.remove('app', first.id), { code: 'BUSY' }));
    await traceStep('offline.first-stop', () => client.stop('app'));
    await traceStep('offline.retained-remove-denial', () => assert.rejects(client.remove('app', first.id), { code: 'BUSY' }));
    await traceStep('offline.first-shutdown', () => client.shutdown());
    let record = (await readProjectRecord(ownerDirectory))!;
    assert.equal(record.endpoint, undefined); assert.equal(record.dataDirectory, dataDirectory);
    assert.deepEqual((await offlinePreviews(record)).map(p => p.name), ['app']);
    const second = JSON.parse((await traceStep('offline.second-start', () => execute(process.execPath, args, { env: { ...process.env, NODE_OPTIONS: `--import=${hook}` }, timeout: 30_000 }))).stdout);
    await traceStep('offline.second-query', async () => { assert.equal(await (await fetch(second.url)).text(), '1'); });
    await traceStep('offline.second-shutdown', () => client.shutdown()); await rm(project, { recursive: true });
    record = (await readProjectRecord(ownerDirectory))!;
    const data = (await offlinePreviews(record))[0].data!;
    await traceStep('offline.deletion-denials', async () => {
      await assert.rejects(removeOfflineProject(ownerDirectory), { code: 'BUSY' });
      await assert.rejects(reviewStaleProject(ownerDirectory), { code: 'CLEANUP_INCOMPLETE' });
      await assert.rejects(client.deleteData('app'), { code: 'EXECUTION_DENIED' });
      await assert.rejects(deleteOfflineData(ownerDirectory, 'app', { expected: { attemptId: null, resources: [{ name: 'other', type: 'postgres' }] } }), { code: 'STALE_ATTEMPT' });
      const lock = await lockProject(ownerDirectory);
      try { await assert.rejects(deleteOfflineData(ownerDirectory, 'app', {}), { code: 'BUSY' }); }
      finally { await lock.close(); }
      const canceled = new AbortController(); canceled.abort();
      await assert.rejects(deleteOfflineData(ownerDirectory, 'app', {}, canceled.signal), { code: 'CLOSED' });
      await fixture.control('lock');
      await assert.rejects(authorized.deleteData('app', { expected: { attemptId: null, resources: data.resources } }), { code: 'SECRET_STORE_UNAVAILABLE' });
      assert.equal((await offlinePreviews(record))[0].data!.cleanup, undefined, 'A locked store must block deletion before Docker changes.');
    });
    const id = createHash('sha256').update(project).digest('hex');
    let launch = '';
    const dashboard = await startDashboard({
      discover: async () => [{ id, tokenFile: join(ownerDirectory, 'token'), retained: record }],
      openBrowser: async url => { launch = url; },
    });
    try {
      await dashboard.open();
      const post = async (body: object, status = 200) => {
        const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
          origin: dashboard.endpoint, authorization: 'Bearer ' + new URL(launch).hash.slice(1), 'content-type': 'application/json',
        }, body: JSON.stringify(body) });
        assert.equal(response.status, status);
        return response.json();
      };
      const deletion = { action: 'deleteData', owner: id, name: 'app', expected: { attemptId: null, resources: data.resources } };
      await traceStep('offline.dashboard-locked-denial', async () => { assert.equal((await post(deletion, 400)).error.code, 'SECRET_STORE_UNAVAILABLE'); });
      assert.equal((await offlinePreviews(record))[0].data!.cleanup, undefined);
      await traceStep('offline.dashboard-unlock', async () => { assert.equal((await post({ action: 'unlockKeystore', password: 'FAKE_fixture_password' })).result.state, 'unlocked'); });
      await traceStep('offline.dashboard-delete', async () => { assert.equal((await post(deletion)).error, undefined); });
    } finally { await traceStep('offline.dashboard-close', () => dashboard.close()); }
    await traceStep('offline.fixture-unlock', () => fixture.control('unlock'));
    assert.deepEqual(await client.list(), []);
    assert.equal(await fixture.store.has('user', 'disposable/shared/api'), true);
    await client.remove();
    assert.equal(await readProjectRecord(ownerDirectory), undefined);
  } finally {
    await traceStep('offline.cleanup', async () => {
      await fixture.control('unlock');
      await client.shutdown().catch(() => {});
      const record = await readProjectRecord(ownerDirectory).catch(() => undefined);
      if (record && !record.endpoint) for (const p of await offlinePreviews(record)) await deleteOfflineData(ownerDirectory, p.name, {});
      await client.close(); await authorized.close();
      await rm(ownerDirectory, { recursive: true, force: true }); await rm(project, { recursive: true, force: true });
    });
  }
});


test('stale removal checks process liveness, locks, exact records, and data metadata without stopping anything', mac, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-stale-record-'));
  const projectDirectory = join(directory, 'removed-source');
  const recordDirectory = join(directory, createHash('sha256').update(projectDirectory).digest('hex'));
  await mkdir(recordDirectory, { mode: 0o700 });
  const dataDirectory = join(directory, 'data');
  const data = await createDataOwner({ directory: dataDirectory }); await data.close();
  const exitedPid = Number((await execute(process.execPath, ['-e', 'console.log(process.pid)'])).stdout);
  const record = { projectDirectory, dataDirectory, endpoint: 'http://127.0.0.1:1', pid: exitedPid };
  try {
    await writeProjectRecord(recordDirectory, { ...record, pid: process.pid });
    await assert.rejects(reviewStaleProject(recordDirectory), { code: 'BUSY' });
    await writeProjectRecord(recordDirectory, record);
    const lock = await lockProject(recordDirectory);
    try { await assert.rejects(removeStaleProject(recordDirectory, record), { code: 'BUSY' }); }
    finally { await lock.close(); }
    const dataInUse = await createDataOwner({ directory: dataDirectory });
    try { await assert.rejects(reviewStaleProject(recordDirectory), { code: 'BUSY' }); }
    finally { await dataInUse.close(); }
    const invalid = join(dataDirectory, 'app.json');
    await writeFile(invalid, '{}', { mode: 0o600 });
    await assert.rejects(reviewStaleProject(recordDirectory), { code: 'CLEANUP_INCOMPLETE' });
    assert.equal(await readFile(invalid, 'utf8'), '{}');
    await rm(invalid);
    assert.deepEqual(await reviewStaleProject(recordDirectory), record);
    await writeProjectRecord(recordDirectory, { ...record, endpoint: 'http://127.0.0.1:2' });
    await assert.rejects(removeStaleProject(recordDirectory, record), { code: 'STALE_ATTEMPT' });
    await writeProjectRecord(recordDirectory, { projectDirectory, endpoint: record.endpoint, pid: exitedPid });
    await assert.rejects(reviewStaleProject(recordDirectory), { code: 'CLEANUP_INCOMPLETE' });
    await writeProjectRecord(recordDirectory, record);
    await removeStaleProject(recordDirectory, record);
    assert.equal(await readProjectRecord(recordDirectory), undefined);
    assert.deepEqual(await offlinePreviews(record), []);
    assert.ok(await readFile(join(recordDirectory, '.lock')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
