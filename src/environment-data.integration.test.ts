import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createClient } from 'redis';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import { createDataOwner } from './data.js';
import { Docker } from './docker.js';
import type { PreviewSpec, PreviewStatus } from './contracts.js';

const dockerSocket = process.env.PREVIEWD_TEST_DOCKER_SOCKET;
const enabled = { skip: process.platform !== 'darwin' || !dockerSocket, timeout: 60_000 };
const signal = () => new AbortController().signal;

async function complete(runtime: PreviewRuntime, value: PreviewStatus) {
  return runtime.wait(value.name, value.candidate!.id);
}
async function ready(runtime: PreviewRuntime, spec: PreviewSpec) {
  const value = await complete(runtime, await runtime.start(spec));
  assert.equal(value.state, 'ready', JSON.stringify(value));
  return value;
}
async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error('Environment cleanup did not finish.');
    await delay(20);
  }
}

test('two consumers share external authenticated databases without acquiring deletion authority', enabled, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-external-data-'));
  const owner = await createDataOwner({ directory: join(directory, 'external'), dockerSocket });
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true });
  try {
    const bindings = await owner.open('shared', { database: { type: 'postgres' }, cache: { type: 'redis' } }, { signal: signal(), onFailure(error) { assert.fail(error); } });
    const pg = new Client({ connectionString: bindings.database.url });
    const redis = createClient({ url: bindings.cache.url, socket: { reconnectStrategy: false } });
    redis.on('error', () => {});
    try {
      await pg.connect(); await redis.connect();
      await pg.query('CREATE TABLE marker (value text)'); await pg.query("INSERT INTO marker VALUES ('shared-data')");
      await redis.set('marker', 'shared-data');
    } finally { await pg.end(); if (redis.isOpen) redis.destroy(); }
    const script = `
      import http from 'node:http';
      import {Client} from ${JSON.stringify(import.meta.resolve('pg'))};
      import {createClient} from ${JSON.stringify(import.meta.resolve('redis'))};
      const pg=new Client({connectionString:process.env.DATABASE_URL});await pg.connect();
      const redis=createClient({url:process.env.REDIS_URL,socket:{reconnectStrategy:false}});redis.on('error',()=>{});await redis.connect();
      http.createServer(async(_req,res)=>{try{res.end(JSON.stringify({sql:(await pg.query('SELECT value FROM marker')).rows[0].value,redis:await redis.get('marker')}));}catch{res.writeHead(503);res.end();}}).listen(Number(process.env.PORT),process.env.HOST);
    `;
    const spec = (name: string): PreviewSpec => ({ name, type: 'environment', primary: 'api', services: {
      database: { type: 'external-postgres', url: bindings.database.url },
      cache: { type: 'external-redis', url: bindings.cache.url },
      api: { type: 'command', cwd: directory, command: [process.execPath, '--input-type=module', '-e', script],
        env: { DATABASE_URL: { service: 'database' }, REDIS_URL: { service: 'cache' } } },
    } });
    const first = await ready(runtime, spec('first'));
    const second = await ready(runtime, spec('second'));
    assert.deepEqual(await (await fetch(first.url!)).json(), { sql: 'shared-data', redis: 'shared-data' });
    const failed = spec('first');
    if (failed.type === 'environment' && failed.services.api.type === 'command') failed.services.api.command = [process.execPath, '-e', 'process.exit(1)'];
    assert.equal((await complete(runtime, await runtime.replace('first', failed))).state, 'failed');
    const canceled = await runtime.replace('first', spec('first'));
    await runtime.cancel('first', canceled.candidate!.id);
    await runtime.stop('first');
    await assert.rejects(runtime.deleteData('first'), { code: 'NOT_FOUND' });
    assert.deepEqual(await (await fetch(second.url!)).json(), { sql: 'shared-data', redis: 'shared-data' });
    await runtime.close();
    assert.equal(owner.status('shared')?.running, true);
    const survivor = new Client({ connectionString: bindings.database.url });
    try { await survivor.connect(); assert.equal((await survivor.query('SELECT value FROM marker')).rows[0].value, 'shared-data'); }
    finally { await survivor.end(); }
    const inspected = JSON.stringify(await runtime.get('first'));
    assert.ok(!inspected.includes(new URL(bindings.database.url).password));
    assert.ok(!inspected.includes(new URL(bindings.cache.url).password));
  } finally {
    await runtime.close(); await owner.stop('shared'); await owner.deleteData('shared'); await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('owned database loss aborts a replacement and stops only its complete environment', enabled, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-environment-loss-'));
  await writeFile(join(directory, 'index.html'), 'available');
  const dataDirectory = join(directory, 'data');
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], dataDirectory, dockerSocket, authorize: () => true });
  const spec: PreviewSpec = { name: 'owned', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory }, cache: { type: 'redis' },
  } };
  try {
    const initial = await ready(runtime, spec);
    const neighbor = await ready(runtime, { name: 'neighbor', type: 'static', directory });
    await symlink(dataDirectory, join(directory, 'public-alias'));
    for (const url of [initial.url!, neighbor.url!]) {
      assert.equal((await fetch(`${url}/data/owned.json`)).status, 403, 'private data records are not public static files');
      assert.equal((await fetch(`${url}/public-alias/owned.json`)).status, 403, 'canonical paths prevent an alias from exposing private data');
    }
    const privateSource = await complete(runtime, await runtime.start({ name: 'private-source', type: 'static', directory: dataDirectory }));
    assert.equal(privateSource.state, 'failed');
    assert.equal(privateSource.error?.code, 'SOURCE_DENIED');
    const candidate = await runtime.replace('owned', { ...spec, services: { ...spec.services,
      web: { type: 'command', cwd: directory, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] },
    } });
    await until(async () => (await runtime.get('owned')).candidate?.services?.web.state === 'starting');
    const record = JSON.parse(await readFile(join(dataDirectory, 'owned.json'), 'utf8'));
    const docker = await Docker.connect(dockerSocket!);
    assert.equal((await docker.request('POST', `/containers/${record.resources[0].container.id}/kill`)).status, 204);
    const result = await runtime.wait('owned', candidate.candidate!.id);
    assert.equal(result.state, 'failed');
    assert.match(result.error!.message, /cache/);
    await until(async () => !(await runtime.get('owned')).busy);
    assert.equal((await runtime.get('owned')).active, undefined);
    assert.equal((await runtime.get('owned')).data?.running, false);
    assert.equal((await runtime.get('owned')).latest?.services?.cache.state, 'stopped');
    await assert.rejects(fetch(initial.url!));
    assert.equal(await (await fetch(neighbor.url!)).text(), 'available');
    assert.equal((await docker.request('GET', `/containers/${record.resources[0].container.id}/json`)).status, 404);
    assert.equal((await docker.request('GET', `/volumes/${record.resources[0].volume}`)).status, 200);
  } finally {
    await runtime.stop('owned'); await runtime.deleteData('owned'); await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistent-data authorization reserves the name and stop cancels pending deletion or recovery', enabled, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-data-authorization-'));
  await writeFile(join(directory, 'index.html'), 'available');
  let allowData = false;
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], dataDirectory: join(directory, 'data'), dockerSocket,
    authorize(request) {
      if (request.operation === 'start' || request.operation === 'replace') return request.spec.name === 'owned';
      assert.equal(request.name, 'owned');
      return allowData ? true : new Promise<boolean>(() => {});
    } });
  const spec: PreviewSpec = { name: 'owned', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory }, cache: { type: 'redis' },
  } };
  try {
    await ready(runtime, spec);
    const stopped = await runtime.stop('owned');
    assert.equal(stopped.latest?.services?.cache.state, 'stopped');
    const deleting = runtime.deleteData('owned');
    const deleted = assert.rejects(deleting, { code: 'CLOSED' });
    await assert.rejects(runtime.start(spec), { code: 'BUSY' });
    await runtime.stop('owned'); await deleted;
    assert.ok((await runtime.get('owned')).data);
    const recovering = runtime.stop('owned', { afterEngineRestart: true });
    const recovered = assert.rejects(recovering, { code: 'CLOSED' });
    await assert.rejects(runtime.stop('owned'), { code: 'CLOSED' });
    await recovered;
    assert.ok((await runtime.get('owned')).data);
  } finally {
    allowData = true; await runtime.stop('owned'); await runtime.deleteData('owned'); await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
