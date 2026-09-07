import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client } from 'pg';
import { createClient } from 'redis';
import { createDataOwner, type DatabaseBinding, type DataOwner } from './data.js';
import { Docker } from './docker.js';
import { probeDatabase } from './database-connections.js';

const dockerSocket = process.env.PREVIEWD_TEST_DOCKER_SOCKET;
const enabled = { skip: process.platform !== 'darwin' || !dockerSocket, timeout: 90_000 };
const specs = { database: { type: 'postgres' as const }, cache: { type: 'redis' as const } };
const signal = () => new AbortController().signal;

test('real owned PostgreSQL and Redis retain authenticated data across stop/reopen and report unexpected exit', enabled, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-real-data-'));
  let owner = await createDataOwner({ directory, dockerSocket });
  const docker = await Docker.connect(dockerSocket!);
  const marker = randomBytes(16).toString('hex');
  try {
    const started = performance.now();
    const bindings = await owner.open('sample', specs, { signal: signal(), onFailure(error) { assert.fail(error); } });
    t.diagnostic(`Authenticated initial startup: ${Math.round(performance.now() - started)} ms`);
    const initial = JSON.parse(await readFile(join(directory, 'sample.json'), 'utf8'));
    assert.equal((await stat(join(directory, 'sample.json'))).mode & 0o777, 0o600);
    for (const resource of initial.resources) {
      const found = await docker.request('GET', `/containers/${resource.container.id}/json`);
      assert.equal(found.status, 200);
      assert.ok(!JSON.stringify(found.body).includes(resource.password), 'Credentials must not enter inspectable container configuration.');
    }
    assert.deepEqual(await owner.open('sample', specs, { signal: signal(), onFailure(error) { assert.fail(error); } }), bindings);
    await clients(bindings, async (pg, redis) => {
      await pg.query('CREATE TABLE durable_marker(value text NOT NULL)');
      await pg.query('INSERT INTO durable_marker VALUES($1)', [marker]);
      await redis.set('durable-marker', marker);
    });
    for (const type of ['postgres', 'redis'] as const) {
      const wrong = new URL(bindings[type === 'postgres' ? 'database' : 'cache'].url); wrong.password = 'wrong-password';
      await assert.rejects(probeDatabase(type, wrong.href, { signal: signal(), timeoutMs: 1500 }), { code: 'START_FAILED' });
    }
    const stopped = performance.now();
    await owner.stop('sample');
    t.diagnostic(`Stop and joined wait streams: ${Math.round(performance.now() - stopped)} ms`);
    assert.equal(owner.status('sample')?.running, false);
    await owner.close();
    owner = await createDataOwner({ directory, dockerSocket });
    assert.deepEqual(owner.names(), ['sample']);
    let unexpected!: (error: Error) => void;
    const unavailable = new Promise<Error>((resolve) => { unexpected = resolve; });
    const reopenedAt = performance.now();
    const reopened = await owner.open('sample', specs, { signal: signal(), onFailure: unexpected });
    t.diagnostic(`Authenticated reopen: ${Math.round(performance.now() - reopenedAt)} ms`);
    const current = JSON.parse(await readFile(join(directory, 'sample.json'), 'utf8'));
    for (let i = 0; i < current.resources.length; i++) {
      assert.equal(current.resources[i].volume, initial.resources[i].volume);
      assert.equal(current.resources[i].password, initial.resources[i].password);
      assert.notEqual(current.resources[i].container.id, initial.resources[i].container.id);
    }
    await clients(reopened, async (pg, redis) => {
      assert.equal((await pg.query('SELECT value FROM durable_marker')).rows[0].value, marker);
      assert.equal(await redis.get('durable-marker'), marker);
    });
    const cache = current.resources.find((item: { name: string }) => item.name === 'cache');
    assert.equal((await docker.request('POST', `/containers/${cache.container.id}/kill`)).status, 204);
    const failure = await bounded(unavailable, 5000);
    assert.match(failure.message, /cache.*unavailable/);
    await assert.rejects(owner.open('sample', specs, { signal: signal(), onFailure() {} }), { code: 'START_FAILED' });
    await owner.stop('sample'); await owner.deleteData('sample');
    for (const resource of current.resources) assert.equal((await docker.request('GET', `/volumes/${resource.volume}`)).status, 404);
    assert.deepEqual(owner.names(), []);
  } finally { await cleanup(owner, directory); }
});

test('real owner SIGKILL releases the kernel lock; recovery removes only its containers and keeps database data', enabled, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-owner-crash-'));
  const otherDirectory = await mkdtemp(join(tmpdir(), 'previewd-other-owner-'));
  let owner: DataOwner | undefined;
  const other = await createDataOwner({ directory: otherDirectory, dockerSocket });
  let child: ChildProcess | undefined;
  const docker = await Docker.connect(dockerSocket!);
  const marker = randomBytes(16).toString('hex');
  try {
    const otherBindings = await other.open('neighbor', { cache: { type: 'redis' } }, { signal: signal(), onFailure(error) { assert.fail(error); } });
    const neighbor = createClient({ url: otherBindings.cache.url, socket: { reconnectStrategy: false } });
    neighbor.on('error', () => {});
    await neighbor.connect(); await neighbor.set('neighbor-marker', marker); neighbor.destroy();
    const script = `
      import {createDataOwner} from ${JSON.stringify(new URL('./data.js', import.meta.url).href)};
      import {Client} from ${JSON.stringify(import.meta.resolve('pg'))};
      import {createClient} from ${JSON.stringify(import.meta.resolve('redis'))};
      const owner=await createDataOwner({directory:process.argv[1],dockerSocket:process.argv[2]});
      const b=await owner.open('sample',{database:{type:'postgres'},cache:{type:'redis'}},{signal:new AbortController().signal,onFailure(){process.exitCode=2;}});
      const pg=new Client({connectionString:b.database.url}); await pg.connect();
      await pg.query('CREATE TABLE durable_marker(value text NOT NULL)'); await pg.query('INSERT INTO durable_marker VALUES($1)',[process.argv[3]]); await pg.end();
      const redis=createClient({url:b.cache.url,socket:{reconnectStrategy:false}});redis.on('error',()=>{});await redis.connect();await redis.set('durable-marker',process.argv[3]);redis.destroy();
      process.stdout.write('ready\\n');
      setInterval(()=>{},10000);
    `;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, dockerSocket!, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    await childReady(child);
    await assert.rejects(createDataOwner({ directory, dockerSocket }), { code: 'BUSY' });
    const before = JSON.parse(await readFile(join(directory, 'sample.json'), 'utf8'));
    child.kill('SIGKILL'); await once(child, 'close');
    const recoveredAt = performance.now();
    owner = await createDataOwner({ directory, dockerSocket });
    t.diagnostic(`Crash recovery of two containers: ${Math.round(performance.now() - recoveredAt)} ms`);
    assert.equal(owner.status('sample')?.running, false);
    assert.equal(owner.status('sample')?.cleanup, undefined);
    for (const resource of before.resources) assert.equal((await docker.request('GET', `/containers/${resource.container.id}/json`)).status, 404);
    const bindings = await owner.open('sample', specs, { signal: signal(), onFailure(error) { assert.fail(error); } });
    await clients(bindings, async (pg, redis) => {
      assert.equal((await pg.query('SELECT value FROM durable_marker')).rows[0].value, marker);
      assert.equal(await redis.get('durable-marker'), marker);
    });
    const retainedNeighbor = createClient({ url: otherBindings.cache.url, socket: { reconnectStrategy: false } });
    retainedNeighbor.on('error', () => {});
    await retainedNeighbor.connect();
    try { assert.equal(await retainedNeighbor.get('neighbor-marker'), marker); }
    finally { retainedNeighbor.destroy(); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
    try { owner ??= await createDataOwner({ directory, dockerSocket }); await cleanup(owner, directory); }
    finally { await cleanup(other, otherDirectory); }
  }
});

async function clients(bindings: Record<string, DatabaseBinding>, run: (pg: Client, redis: {
  get(key: string): Promise<unknown>; set(key: string, value: string): Promise<unknown>;
}) => Promise<void>) {
  const pg = new Client({ connectionString: bindings.database.url, connectionTimeoutMillis: 3000 });
  const redis = createClient({ url: bindings.cache.url, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
  redis.on('error', () => {});
  try { await pg.connect(); await redis.connect(); await run(pg, redis); }
  finally { await pg.end(); if (redis.isOpen) redis.destroy(); }
}
async function cleanup(owner: DataOwner, directory: string) {
  for (const name of owner.names()) { await owner.stop(name); await owner.deleteData(name); }
  await owner.close(); await rm(directory, { recursive: true, force: true });
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline exceeded.')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function childReady(child: ChildProcess) {
  let output = '';
  let errorOutput = '';
  await bounded(new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('ready\n')) resolve(); });
    child.stderr!.on('data', (chunk: Buffer) => { errorOutput = `${errorOutput}${chunk}`.slice(-4096); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Database fixture child exited before ready: ${errorOutput}`)));
  }), 40_000);
}
