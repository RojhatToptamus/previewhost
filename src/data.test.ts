import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, readFile, writeFile, readdir, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createDataOwner, type DataOwner } from './data.js';
import { createPreviewRuntime } from './runtime.js';

const mac = { skip: process.platform !== 'darwin' };
const signal = () => new AbortController().signal;
const pg = { database: { type: 'postgres' as const } };
const dataModule = new URL('./data.js', import.meta.url).href;

test('the permanent data lock excludes another process and is not inherited by unrelated children', mac, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-lock-'));
  const owner = await createDataOwner({ directory });
  let sleeper: ReturnType<typeof spawn> | undefined;
  try {
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import {createDataOwner} from ${JSON.stringify(dataModule)}; try { await createDataOwner({directory:process.argv[1]}); process.exit(2); } catch(e) { console.log(e.code); }`, directory]);
    assert.equal(result.stdout.trim(), 'BUSY');
    sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    await owner.close();
    const next = await createDataOwner({ directory });
    await next.close();
  } finally {
    if (sleeper && sleeper.exitCode === null && sleeper.signalCode === null) { sleeper.kill('SIGKILL'); await once(sleeper, 'close'); }
    await owner.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('unsafe or corrupt retained records fail closed before Docker access', mac, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-record-'));
  const outside = join(directory, 'outside');
  try {
    const owner = await createDataOwner({ directory }); await owner.close();
    for (const contents of ['{bad', 'x'.repeat(65_537)]) {
      await writeFile(join(directory, 'sample.json'), contents, { mode: 0o600 });
      await assert.rejects(createDataOwner({ directory, dockerSocket: '/unavailable.sock' }));
      await rm(join(directory, 'sample.json'));
    }
    await writeFile(outside, 'keep', { mode: 0o600 });
    await symlink(outside, join(directory, 'sample.json'));
    await assert.rejects(createDataOwner({ directory, dockerSocket: '/unavailable.sock' }));
    assert.equal(await readFile(outside, 'utf8'), 'keep');
    await rm(join(directory, 'sample.json')); await rm(outside);
    await chmod(directory, 0o755);
    await assert.rejects(createDataOwner({ directory }), { code: 'CLEANUP_INCOMPLETE' });
    await chmod(directory, 0o700);
    const next = await createDataOwner({ directory }); await next.close();
  } finally { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); }
});

test('a FIFO retained record cannot block owner startup while holding the kernel lock', mac, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-record-fifo-'));
  try {
    const owner = await createDataOwner({ directory }); await owner.close();
    await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', join(directory, 'sample.json')]);
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import {createDataOwner} from ${JSON.stringify(dataModule)}; try { await createDataOwner({directory:process.argv[1]}); process.exit(2); } catch(e) { console.log(e.code); }`, directory], { timeout: 2000 });
    assert.equal(result.stdout.trim(), 'CLEANUP_INCOMPLETE');
    await rm(join(directory, 'sample.json'));
    const next = await createDataOwner({ directory }); await next.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('absent lost creation remains owned until positively observed; failed close retains the lock', mac, async () => {
  const fixture = await faultEngine('volume-lost-absent');
  const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  try {
    await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }), { code: 'CLEANUP_INCOMPLETE' });
    assert.equal(fixture.sawPublishedIntent, true);
    assert.ok(owner.status('sample')?.cleanup);
    await assert.rejects(owner.stop('sample'), { code: 'CLEANUP_INCOMPLETE' });
    await assert.rejects(owner.close(), { code: 'CLEANUP_INCOMPLETE' });
    await assert.rejects(createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket }), { code: 'BUSY' });
    fixture.completeVolume();
    await owner.stop('sample');
    assert.equal(owner.status('sample')?.cleanup, undefined);
    assert.equal(fixture.volumes.size, 1);
    await owner.deleteData('sample');
    assert.equal(fixture.volumes.size, 0);
  } finally { fixture.completeVolume(); await finish(owner, fixture); }
});

test('an operator acknowledgment clears only an absent pending create on the same engine', mac, async () => {
  const fixture = await faultEngine('volume-lost-absent');
  const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  try {
    await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }));
    fixture.engineId = 'different-engine';
    await assert.rejects(owner.stop('sample', { afterEngineRestart: true }), { code: 'CLEANUP_INCOMPLETE' });
    fixture.engineId = 'fixture-engine';
    await owner.stop('sample', { afterEngineRestart: true });
    assert.equal(owner.status('sample')?.cleanup, undefined);
    assert.equal(fixture.volumes.size, 0);
    assert.equal(fixture.deletions.length, 0);
    await owner.deleteData('sample');
  } finally { fixture.engineId = 'fixture-engine'; await finish(owner, fixture, true); }
});

test('public recovery remains available after failed runtime close and releases data ownership', mac, async () => {
  const fixture = await faultEngine('volume-lost-absent');
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], dataDirectory: fixture.data,
    dockerSocket: fixture.socket, authorize: () => true });
  try {
    const started = await runtime.start({ name: 'sample', type: 'environment', primary: 'web', services: {
      web: { type: 'static', directory: fixture.directory }, database: { type: 'postgres' },
    } });
    const result = await runtime.wait('sample', started.candidate!.id);
    assert.equal(result.state, 'cleanup-incomplete');
    await assert.rejects(runtime.close(), { code: 'CLEANUP_INCOMPLETE' });
    const recovered = await runtime.stop('sample', { afterEngineRestart: true });
    assert.equal(recovered.data?.cleanup, undefined);
    await runtime.close();
    await runtime.close();
    assert.equal((await runtime.stop('sample')).data?.running, false);
    const next = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
    try { await next.deleteData('sample'); } finally { await next.close(); }
    assert.equal(fixture.deletions.length, 0);
  } finally {
    await runtime.stop('sample', { afterEngineRestart: true }).catch(() => {});
    try { await runtime.close(); } finally { await fixture.close(); }
  }
});

test('the runtime counts unresolved database ownership against its total live-node limit', mac, async () => {
  const fixture = await faultEngine('volume-lost-absent');
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], dataDirectory: fixture.data, dockerSocket: fixture.socket,
    authorize: (request) => request.operation !== 'start' || request.spec.name === 'sample' ? true : new Promise<boolean>((resolve) => {
      request.signal.addEventListener('abort', () => resolve(false), { once: true });
    }) });
  try {
    const started = await runtime.start({ name: 'sample', type: 'environment', primary: 'web', services: {
      web: { type: 'static', directory: fixture.directory }, database: { type: 'postgres' },
    } });
    assert.equal((await runtime.wait('sample', started.candidate!.id)).state, 'cleanup-incomplete');
    for (let i = 0; i < 8; i++) {
      const count = i === 7 ? 15 : 16;
      await runtime.start({ name: `reserved-${i}`, type: 'environment', primary: 'node-0', services:
        Object.fromEntries(Array.from({ length: count }, (_, node) => [`node-${node}`, {
          type: 'command' as const, cwd: fixture.directory, command: [process.execPath, '-e', 'process.exit(2)'],
        }])) });
    }
    await assert.rejects(runtime.start({ name: 'overflow', type: 'static', directory: fixture.directory }), { code: 'BUSY' });
    assert.equal(fixture.containers.size, 0);
  } finally {
    await Promise.allSettled((await runtime.list()).map((entry) => runtime.stop(entry.name)));
    await runtime.stop('sample', { afterEngineRestart: true });
    await runtime.close();
    const next = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
    try { await next.deleteData('sample'); } finally { await next.close(); await fixture.close(); }
  }
});

test('full ownership labels prevent adoption or deletion of a foreign same-name volume', mac, async () => {
  const fixture = await faultEngine('volume-lost-absent');
  const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  try {
    await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }));
    fixture.completeVolume(true);
    await assert.rejects(owner.stop('sample', { afterEngineRestart: true }), { code: 'CLEANUP_INCOMPLETE' });
    assert.equal(fixture.deletions.length, 0);
    fixture.completeVolume();
    await owner.stop('sample'); await owner.deleteData('sample');
  } finally { fixture.completeVolume(); await finish(owner, fixture); }
});

for (const mode of ['container-lost-created', 'start-lost-created'] as const) {
  test(`${mode} recovers the exact container identity and removes it while retaining data`, mac, async () => {
    const fixture = await faultEngine(mode);
    const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
    try {
      await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }));
      assert.equal(fixture.containers.size, 0);
      assert.equal(fixture.volumes.size, 1);
      assert.equal(fixture.deletions.filter((item) => item.startsWith('/containers/')).length, 1);
      assert.equal(owner.status('sample')?.cleanup, undefined);
      const record = JSON.parse(await readFile(join(fixture.data, 'sample.json'), 'utf8'));
      assert.equal(record.pending, undefined);
      assert.equal(record.resources[0].container, undefined);
      await owner.deleteData('sample');
    } finally { await finish(owner, fixture); }
  });
}

test('cancellation joins a dispatched creation; failed removal keeps the exact ID for retry', mac, async () => {
  const fixture = await faultEngine('container-remove-lost');
  const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  const controller = new AbortController();
  fixture.afterContainerCreate = () => controller.abort();
  try {
    await assert.rejects(owner.open('sample', pg, { signal: controller.signal, onFailure() {} }), { code: 'CLEANUP_INCOMPLETE' });
    assert.equal(fixture.containers.size, 1);
    const record = JSON.parse(await readFile(join(fixture.data, 'sample.json'), 'utf8'));
    const container = record.resources[0].container;
    assert.match(container.id, /^[a-f0-9]{64}$/);
    assert.equal(record.pending.operation, 'remove-container');
    await owner.stop('sample');
    assert.equal(fixture.containers.size, 0);
    assert.equal(fixture.deletions.filter((item) => item.includes(container.id)).length, 2);
    await owner.deleteData('sample');
  } finally { await finish(owner, fixture); }
});

test('partial volume deletion is recoverable and recreated data uses a fresh random volume name', mac, async () => {
  const fixture = await faultEngine('container-lost-created');
  const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  try {
    await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }));
    const oldVolume = [...fixture.volumes.keys()][0];
    fixture.loseVolumeRemoval = true;
    await assert.rejects(owner.deleteData('sample'));
    await owner.stop('sample');
    await owner.deleteData('sample');
    await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }));
    assert.notEqual([...fixture.volumes.keys()][0], oldVolume);
    await owner.deleteData('sample');
  } finally { await finish(owner, fixture); }
});

test('concurrent new names cannot exceed the retained-data limit', mac, async () => {
  const fixture = await faultEngine('volume-lost-absent');
  let owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  await owner.close();
  const ownerId = (await readFile(join(fixture.data, '.lock'), 'utf8')).trim();
  for (let i = 0; i < 127; i++) {
    const name = `saved-${i}`;
    await writeFile(join(fixture.data, `${name}.json`), JSON.stringify({ schema: 1, name, owner: ownerId,
      engine: { id: fixture.engineId, socket: fixture.socket }, resources: [{ name: 'database', type: 'postgres',
        password: randomBytes(32).toString('hex') }] }), { mode: 0o600 });
  }
  owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
  const controller = new AbortController();
  fixture.onInfo = async () => {
    if ((await readdir(fixture.data)).filter((name) => name.endsWith('.json')).length === 128) controller.abort();
  };
  try {
    const results = await Promise.allSettled(['first', 'second'].map((name) => owner.open(name, pg, { signal: controller.signal, onFailure() {} })));
    assert.equal(owner.names().length, 128);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'BUSY').length, 1);
    assert.equal(fixture.mutationRequests, 0);
  } finally { await finish(owner, fixture); }
});

test('failed intent publication and missing cached images dispatch no Docker mutation', mac, async () => {
  for (const blocked of ['publication', 'image'] as const) {
    const fixture = await faultEngine('volume-lost-absent');
    const owner = await createDataOwner({ directory: fixture.data, dockerSocket: fixture.socket });
    if (blocked === 'image') fixture.imagesMissing = true;
    else fixture.onInfo = async () => {
      if ((await readdir(fixture.data)).includes('sample.json')) await chmod(fixture.data, 0o500);
    };
    try {
      await assert.rejects(owner.open('sample', pg, { signal: signal(), onFailure() {} }));
      assert.equal(fixture.mutationRequests, 0);
      assert.equal(fixture.volumes.size, 0);
      assert.equal(fixture.containers.size, 0);
    } finally { fixture.onInfo = async () => {}; await chmod(fixture.data, 0o700); await finish(owner, fixture); }
  }
});

type FaultMode = 'volume-lost-absent' | 'container-lost-created' | 'start-lost-created' | 'container-remove-lost';
async function faultEngine(mode: FaultMode) {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-engine-'));
  const data = join(directory, 'data');
  const socket = join(directory, 'engine.sock');
  const volumes = new Map<string, Record<string, any>>();
  const containers = new Map<string, Record<string, any>>();
  const sockets = new Set<Socket>();
  const imageId = `sha256:${'a'.repeat(64)}`;
  let volumeIntent: Record<string, any> | undefined;
  let lostRemoval = false;
  const fixture = { directory, data, socket, volumes, containers, deletions: [] as string[], engineId: 'fixture-engine', sawPublishedIntent: false,
    onInfo: async () => {}, imagesMissing: false, mutationRequests: 0,
    afterContainerCreate: () => {}, loseVolumeRemoval: false,
    completeVolume(foreign = false) {
      if (!volumeIntent) return;
      const value = structuredClone(volumeIntent);
      if (foreign) value.Labels['io.previewd.resource'] = 'foreign';
      volumes.set(value.Name, value);
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const url = new URL(req.url!, 'http://engine');
      const path = url.pathname.replace('/v1.40', '');
      const send = (status: number, value?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
      if (path === '/info') { await fixture.onInfo(); send(200, { ID: fixture.engineId }); return; }
      if (path === '/images/json') { send(200, fixture.imagesMissing ? [] : [{ Id: imageId, RepoTags: ['postgres:17-alpine', 'redis:7-alpine'] }]); return; }
      if (path === `/images/${imageId}/json`) { send(200, { Id: imageId }); return; }
      if (req.method === 'POST' && path === '/volumes/create') {
        fixture.mutationRequests++;
        const record = JSON.parse(await readFile(join(data, 'sample.json'), 'utf8'));
        fixture.sawPublishedIntent = record.pending?.operation === 'create-volume' && record.resources[0].volume === body.Name;
        volumeIntent = body;
        if (mode === 'volume-lost-absent') { res.destroy(); return; }
        fixture.completeVolume(); send(201, body); return;
      }
      if (req.method === 'GET' && path.startsWith('/volumes/')) {
        const value = volumes.get(path.slice('/volumes/'.length)); send(value ? 200 : 404, value); return;
      }
      if (req.method === 'POST' && path === '/containers/create') {
        const id = randomBytes(32).toString('hex');
        const value = { Id: id, Name: `/${url.searchParams.get('name')}`, Config: body };
        containers.set(id, value); fixture.afterContainerCreate();
        if (mode === 'container-lost-created') { res.destroy(); return; }
        send(201, { Id: id }); return;
      }
      if (req.method === 'GET' && /^\/containers\/.+\/json$/.test(path)) {
        const id = path.slice('/containers/'.length, -'/json'.length);
        const value = containers.get(id) ?? [...containers.values()].find((item) => item.Name === `/${id}`);
        send(value ? 200 : 404, value); return;
      }
      if (req.method === 'POST' && path.endsWith('/start')) { res.destroy(); return; }
      if (req.method === 'DELETE') {
        fixture.deletions.push(path);
        if (path.startsWith('/containers/')) {
          if (mode === 'container-remove-lost' && !lostRemoval) { lostRemoval = true; res.destroy(); return; }
          containers.delete(path.slice('/containers/'.length));
        } else if (path.startsWith('/volumes/')) {
          volumes.delete(path.slice('/volumes/'.length));
          if (fixture.loseVolumeRemoval) { fixture.loseVolumeRemoval = false; res.destroy(); return; }
        }
        send(204); return;
      }
      send(500, { message: 'Unsupported simulated Engine operation.' });
    } catch { res.destroy(); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); socket.on('data', () => {}); });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return fixture;
}

async function finish(owner: DataOwner, fixture: Awaited<ReturnType<typeof faultEngine>>, acknowledge = false) {
  try {
    for (const name of owner.names()) { await owner.stop(name, { afterEngineRestart: acknowledge }); await owner.deleteData(name); }
    await owner.close();
  }
  finally { await fixture.close(); }
}
