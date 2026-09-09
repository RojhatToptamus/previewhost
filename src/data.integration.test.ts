import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { testKeychain } from './testSupport/keychain.js';
import { keychain } from './keychain.js';
import { PreviewError } from './errors.js';
import { createPreviewRuntime } from './runtime.js';

const dockerSocket = process.env.PREVIEWD_TEST_DOCKER_SOCKET;
const enabled = { skip: process.platform !== 'darwin' || !dockerSocket, timeout: 90_000 };
const specs = { database: { type: 'postgres' as const }, cache: { type: 'redis' as const } };
const signal = () => new AbortController().signal;

test('real owned PostgreSQL and Redis retain authenticated data across stop/reopen and report unexpected exit', enabled, async (t) => {
  await testKeychain(t);
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-real-data-'));
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
      assert.ok(!JSON.stringify(found.body).includes(new URL(bindings[resource.name].url).password), 'Credentials must not enter inspectable container configuration.');
      assert.equal(resource.password, undefined);
      assert.equal(typeof resource.credentialRef, 'string');
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
      assert.equal(current.resources[i].credentialRef, initial.resources[i].credentialRef);
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
  const keychainFixture = await testKeychain(t);
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-owner-crash-'));
  const otherDirectory = await mkdtemp(join(tmpdir(), 'previewhost-other-owner-'));
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
      ${keychainFixture.installSource}
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

test('legacy migration retries exact copied passwords and preserves real PostgreSQL/Redis authentication and data', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const directory = join(fixture.directory, 'data');
  let owner = await createDataOwner({ directory, dockerSocket });
  const marker = randomBytes(16).toString('hex');
  try {
    const bindings = await owner.open('legacy', specs, { signal: signal(), onFailure(error) { assert.fail(error); } });
    await clients(bindings, async (pg, redis) => {
      await pg.query('CREATE TABLE legacy_marker(value text NOT NULL)');
      await pg.query('INSERT INTO legacy_marker VALUES($1)', [marker]);
      await redis.set('legacy-marker', marker);
    });
    await owner.stop('legacy'); await owner.close();
    const filename = join(directory, 'legacy.json');
    const current = JSON.parse(await readFile(filename, 'utf8'));
    const legacy = { ...current, schema: 1, resources: [] as Array<Record<string, string>> };
    for (const resource of current.resources) {
      const { credentialRef, ...metadata } = resource;
      const password = await fixture.store.get('database', credentialRef);
      assert.ok(password);
      legacy.resources.push({ ...metadata, password });
      await fixture.store.remove('database', credentialRef);
    }
    const original = `${JSON.stringify(legacy)}\n`;
    await writeFile(filename, original, { mode: 0o600 });
    await fixture.control('lock');
    owner = await createDataOwner({ directory, dockerSocket });
    await owner.stop('legacy'); // Metadata recovery never asks Keychain to unlock.
    await assert.rejects(owner.open('legacy', specs, { signal: signal(), onFailure() {} }), { code: 'SECRET_STORE_UNAVAILABLE' });
    assert.equal(await readFile(filename, 'utf8'), original);
    await fixture.control('unlock');
    const add = keychain.add.bind(keychain);
    const interrupted = t.mock.method(keychain, 'add', async (...args: Parameters<typeof add>) => {
      if (args[1].endsWith('/cache')) throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'Synthetic interrupted migration.');
      return add(...args);
    });
    await assert.rejects(owner.open('legacy', specs, { signal: signal(), onFailure() {} }), { code: 'SECRET_STORE_UNAVAILABLE' });
    interrupted.mock.restore();
    assert.equal(await readFile(filename, 'utf8'), original);
    assert.equal(await fixture.store.get('migration', `${legacy.owner}/legacy/database`), legacy.resources[0].password);
    await fixture.store.add('migration', `${legacy.owner}/legacy/cache`, 'f'.repeat(64));
    await assert.rejects(owner.open('legacy', specs, { signal: signal(), onFailure() {} }), { code: 'SECRET_STORE_UNAVAILABLE' });
    assert.equal(await readFile(filename, 'utf8'), original);
    await fixture.store.update('migration', `${legacy.owner}/legacy/cache`, legacy.resources[1].password);
    const migrated = await owner.open('legacy', specs, { signal: signal(), onFailure(error) { assert.fail(error); } });
    const record = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(record.schema, 2);
    assert.deepEqual(record.resources.map((item: { credentialRef: string }) => item.credentialRef),
      [`${legacy.owner}/legacy/database`, `${legacy.owner}/legacy/cache`]);
    for (const resource of legacy.resources) assert.ok(!JSON.stringify(record).includes(resource.password));
    await clients(migrated, async (pg, redis) => {
      assert.equal((await pg.query('SELECT value FROM legacy_marker')).rows[0].value, marker);
      assert.equal(await redis.get('legacy-marker'), marker);
    });
    await fixture.control('lock');
    await owner.stop('legacy'); await owner.close();
    await fixture.control('unlock');
    owner = await createDataOwner({ directory, dockerSocket });
    await owner.deleteData('legacy');
    for (const resource of record.resources) assert.equal(await fixture.store.has('migration', resource.credentialRef), false);
  } finally { await fixture.control('unlock'); await cleanup(owner, directory); }
});

test('missing retained credentials never regenerate; locked deletion persists exact debt and remains retryable after restart', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const directory = join(fixture.directory, 'data');
  const filename = join(directory, 'retained.json');
  const database = { cache: { type: 'redis' as const } };
  const docker = await Docker.connect(dockerSocket!);
  let owner = await createDataOwner({ directory, dockerSocket });
  let runtime: Awaited<ReturnType<typeof createPreviewRuntime>> | undefined;
  try {
    const bindings = await owner.open('retained', database, { signal: signal(), onFailure(error) { assert.fail(error); } });
    const first = JSON.parse(await readFile(filename, 'utf8'));
    const reference = first.resources[0].credentialRef;
    const password = new URL(bindings.cache.url).password;
    await owner.stop('retained');
    const stopped = await readFile(filename, 'utf8');
    await fixture.store.remove('database', reference);
    await assert.rejects(owner.open('retained', database, { signal: signal(), onFailure() {} }), { code: 'SECRET_REQUIRED' });
    assert.equal(await readFile(filename, 'utf8'), stopped);
    assert.equal((await docker.request('GET', `/volumes/${first.resources[0].volume}`)).status, 200);
    assert.equal(await fixture.store.has('database', reference), false);
    await fixture.store.add('database', reference, password);
    assert.ok((await owner.open('retained', database, { signal: signal(), onFailure() {} })).cache.url);
    await owner.stop('retained'); await fixture.control('lock');
    await assert.rejects(owner.deleteData('retained'), { code: 'SECRET_STORE_UNAVAILABLE' });
    const debt = JSON.parse(await readFile(filename, 'utf8'));
    assert.deepEqual(debt.pending, { operation: 'remove-credential', resource: 'cache' });
    assert.equal(debt.resources[0].volume, undefined);
    assert.equal((await docker.request('GET', `/volumes/${first.resources[0].volume}`)).status, 404);
    await owner.close();
    runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], dataDirectory: directory, dockerSocket, authorize: () => true });
    assert.equal((await runtime.get('retained')).data?.cleanup?.operation, 'remove-credential');
    await runtime.stop('retained');
    await assert.rejects(runtime.deleteData('retained'), { code: 'SECRET_STORE_UNAVAILABLE' });
    await fixture.control('unlock');
    await runtime.deleteData('retained');
    assert.equal(await fixture.store.has('database', reference), false);
    await runtime.close(); runtime = undefined;
    owner = await createDataOwner({ directory, dockerSocket });
    await owner.open('retained', database, { signal: signal(), onFailure() {} });
    const recreated = JSON.parse(await readFile(filename, 'utf8'));
    assert.notEqual(recreated.resources[0].credentialRef, reference);
    await fixture.store.remove('database', reference); // A late exact old removal cannot affect the new resource.
    assert.equal(await fixture.store.has('database', recreated.resources[0].credentialRef), true);
  } finally {
    await fixture.control('unlock');
    if (runtime) { await runtime.stop('retained'); await runtime.deleteData('retained'); await runtime.close(); }
    await cleanup(owner, directory);
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
