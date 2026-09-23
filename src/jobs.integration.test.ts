import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import { parseSpec } from './spec.js';
import { loadPreviewSpec, savePreviewSpec } from './config.js';
import { PreviewError } from './errors.js';
import type { PreviewSpec, PreviewStatus, RuntimeOptions } from './contracts.js';
import { testKeystore } from './testSupport/keystore.js';

type Spec = Extract<PreviewSpec, { type: 'environment' }>;
const native = { timeout: 30_000 };
const dockerSocket = process.env.PREVIEWHOST_TEST_DOCKER_SOCKET;
const database = { skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET', timeout: 120_000 };
async function outcome(runtime: PreviewRuntime, started: PreviewStatus, signal: AbortSignal) {
  for (;;) {
    try {
      // Exercise pending observation windows without extending startup or repeating effects.
      return await runtime.wait(started.name, started.candidate!.id, { timeoutMs: 1000, signal });
    } catch (error) {
      if (!(error instanceof PreviewError) || error.code !== 'TIMEOUT') throw error;
    }
  }
}
async function until(check: () => Promise<boolean>, signal = AbortSignal.timeout(10_000)) {
  while (!await check()) await delay(20, undefined, { signal });
}
async function seedWaiting(f: Awaited<ReturnType<typeof databaseFixture>>, started: PreviewStatus, signal: AbortSignal) {
  await until(async () => {
    const status = await f.runtime.get(started.name);
    assert.equal(status.candidate?.id, started.candidate!.id, JSON.stringify(status.latest));
    return access(join(f.directory, 'waiting')).then(() => true, () => false);
  }, signal);
}
async function folder(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}
const job = (cwd: string, script: string) => ({ type: 'job' as const, cwd, command: [process.execPath, '-e', script] });

test('job graph rejects missing dependencies, cycles, job URLs, job primary and unowned once jobs', () => {
  const spec: Spec = { name: 'graph', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory: '/tmp', dependsOn: ['migrate'] }, migrate: job('/tmp', ''),
  } };
  assert.equal(parseSpec(spec).type, 'environment');
  assert.throws(() => parseSpec({ ...spec, primary: 'migrate' }), /primary service/);
  assert.throws(() => parseSpec({ ...spec, services: { ...spec.services, migrate: { ...job('/tmp', ''), dependsOn: ['web'] } } }), /cycle/);
  assert.throws(() => parseSpec({ ...spec, services: { ...spec.services, migrate: { ...job('/tmp', ''), dependsOn: ['missing'] } } }), /missing node/);
  assert.throws(() => parseSpec({ ...spec, services: { ...spec.services, migrate: { ...job('/tmp', ''), env: { URL: { service: 'migrate' } } } } }), /no connection URL/);
  assert.throws(() => parseSpec({ ...spec, services: { ...spec.services, migrate: { ...job('/tmp', ''), run: 'once' } } }), /managed database dependency/);
});

test('aborting outcome stops test continuation while startup remains pending for explicit cleanup', { timeout: 5000 }, async t => {
  const directory = await folder(t);
  let entered!: () => void;
  const authorizing = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => {
    entered();
    return new Promise<boolean>(() => {});
  } });
  t.after(() => runtime.close());
  const started = await runtime.start({ name: 'abort-observation', type: 'static', directory });
  await authorizing;
  const controller = new AbortController();
  let continued = false;
  const observing = outcome(runtime, started, controller.signal).then(() => { continued = true; });
  controller.abort();
  await assert.rejects(observing, { code: 'CLOSED' });
  assert.equal(continued, false);
  const pending = await runtime.get(started.name);
  assert.equal(pending.candidate?.id, started.candidate!.id);
  assert.equal(pending.candidate?.state, 'starting');
  assert.equal((await runtime.cancel(started.name, started.candidate!.id)).latest?.state, 'canceled');
});

test('jobs round trip relative YAML paths and share source, execution and secret authorization', native, async t => {
  const directory = await folder(t);
  const spec: Spec = { name: 'configuration', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory, dependsOn: ['prepare'] }, prepare: { ...job(directory, ''), env: { TOKEN: { secret: 'disposable/jobs' } } },
  } };
  const saved = await savePreviewSpec(spec, { projectDirectory: directory, allowedRoots: [directory] });
  assert.match(await readFile(saved.file, 'utf8'), /cwd: \./);
  assert.deepEqual(await loadPreviewSpec(saved.file, { allowedRoots: [directory] }), parseSpec(spec));
  const runtime = await createPreviewRuntime({ allowedRoots: [directory] }); t.after(() => runtime.close());
  const inspected = await runtime.inspect(spec);
  assert.deepEqual(inspected.secrets?.[0].bindings, [{ key: 'TOKEN', service: 'prepare' }]);
  assert.equal((await outcome(runtime, await runtime.start(spec), t.signal)).error?.code, 'EXECUTION_DENIED');
  if (spec.services.prepare.type === 'job') spec.services.prepare.cwd = '/';
  await assert.rejects(runtime.inspect(spec), { code: 'SOURCE_DENIED' });
});

test('finite jobs gate servers, preserve short output, fail closed, rerun and clean descendants', native, async t => {
  const directory = await folder(t);
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true }); t.after(() => runtime.close());
  const spec: Spec = { name: 'native-jobs', type: 'environment', primary: 'web', services: {
    prepare: job(directory, `require('fs').writeFileSync('index.html','ready'); console.log('final output');`),
    web: { type: 'static', directory, dependsOn: ['prepare'] },
  } };
  for (let i = 0; i < 3; i++) {
    const ready = await outcome(runtime, await runtime.start(spec), t.signal);
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.equal(ready.services?.prepare.state, 'succeeded');
    assert.equal(await (await fetch(ready.url!)).text(), 'ready');
    assert.match((await runtime.logs(spec.name)).text, /final output/);
    await runtime.stop(spec.name);
  }
  if (spec.services.prepare.type === 'job') spec.services.prepare.command = [process.execPath, '-e', 'console.error("migration failed"); process.exit(7)'];
  const failed = await outcome(runtime, await runtime.start(spec), t.signal);
  assert.equal(failed.state, 'failed'); assert.equal(failed.services?.prepare.state, 'failed');
  assert.notEqual(failed.services?.web.state, 'ready');
  assert.match((await runtime.logs(spec.name)).text, /migration failed/);
  if (spec.services.prepare.type === 'job') spec.services.prepare.command = [process.execPath, '-e', 'process.exit(0)'];
  const fixed = await outcome(runtime, await runtime.start(spec), t.signal); assert.equal(fixed.state, 'ready');
  await assert.rejects(runtime.rerunJob(spec.name, fixed.id, 'prepare'), { code: 'BUSY' });
  const stopped = await runtime.stop(spec.name);
  assert.equal((await outcome(runtime, await runtime.rerunJob(spec.name, stopped.latest!.id, 'prepare'), t.signal)).state, 'ready');
  await assert.rejects(runtime.rerunJob(spec.name, failed.id, 'prepare'), { code: 'ATTEMPT_EXPIRED' });
});

test('timeout and cancellation stop job process groups before startup returns', native, async t => {
  const directory = await folder(t);
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true }); t.after(() => runtime.close());
  const script = `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync('pids',process.pid+' '+child.pid); setInterval(()=>{},1000)`;
  const spec: Spec = { name: 'cancel-jobs', type: 'environment', primary: 'web', services: {
    slow: { ...job(directory, script), timeoutMs: 1000 }, web: { type: 'static', directory, dependsOn: ['slow'] },
  } };
  const failed = await outcome(runtime, await runtime.start(spec), t.signal);
  assert.equal(failed.error?.code, 'TIMEOUT'); assert.equal(failed.services?.slow.state, 'failed');
  for (const pid of (await readFile(join(directory, 'pids'), 'utf8')).split(' ').map(Number)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await rm(join(directory, 'pids'));
  if (spec.services.slow.type === 'job') spec.services.slow.timeoutMs = 20_000;
  const starting = await runtime.start(spec);
  await until(() => access(join(directory, 'pids')).then(() => true, () => false));
  const canceled = await runtime.cancel(spec.name, starting.candidate!.id);
  assert.equal(canceled.latest?.state, 'canceled');
  assert.equal(canceled.latest?.services?.slow.state, 'canceled');
  for (const pid of (await readFile(join(directory, 'pids'), 'utf8')).split(' ').map(Number)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

async function databaseFixture(t: test.TestContext, authorize: RuntimeOptions['authorize'] = () => true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-jobs-')));
  let runtime: PreviewRuntime;
  t.after(async () => {
    if (runtime) { for (const p of await runtime.list()) { await runtime.stop(p.name); if (p.data) await runtime.deleteData(p.name); } await runtime.close(); }
    await rm(directory, { recursive: true, force: true });
  });
  const keys = await testKeystore(t);
  await keys.store.add('user', 'disposable/jobs-seed', 'fake-job-secret-value');
  const options = { allowedRoots: [directory], dataDirectory: join(directory, 'data'), dockerSocket, secretIds: ['disposable/jobs-seed'], authorize };
  runtime = await createPreviewRuntime(options);
  const connection = `import {Client} from ${JSON.stringify(import.meta.resolve('pg'))}; const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();`;
  await writeFile(join(directory, 'migrate.mjs'), connection + `await db.query('CREATE TABLE IF NOT EXISTS items (id serial primary key, label text)'); console.log('schema ready'); await db.end();`);
  await writeFile(join(directory, 'seed.mjs'), connection + `import fs from 'node:fs'; await db.query("INSERT INTO items(label) VALUES ('demo')"); console.log('seed wrote',process.env.TEST_TOKEN); const mode=fs.existsSync('mode')?fs.readFileSync('mode','utf8'):''; if(mode==='fail')process.exit(9); if(mode==='wait'){fs.writeFileSync('waiting','');await new Promise(()=>{});} await db.end();`);
  await writeFile(join(directory, 'api.mjs'), connection + `import http from 'node:http'; http.createServer(async(req,res)=>{try { if(req.method==='POST') await db.query("INSERT INTO items(label) VALUES ('user')"); const {rows}=await db.query('SELECT * FROM items ORDER BY id'); res.setHeader('content-type','application/json'); res.end(JSON.stringify(rows)); } catch {res.writeHead(503);res.end('Database not ready');}}).listen(Number(process.env.PORT),process.env.HOST);`);
  await writeFile(join(directory, 'web.mjs'), `import http from 'node:http'; http.createServer(async(req,res)=>{try {const r=await fetch(process.env.API_URL,{method:req.method});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());}catch{res.writeHead(503);res.end();}}).listen(Number(process.env.PORT),process.env.HOST);`);
  const spec: Spec = { name: 'job-data', type: 'environment', primary: 'web', timeoutMs: 60_000, services: {
    db: { type: 'postgres' },
    migrate: { type: 'job', cwd: directory, command: [process.execPath, 'migrate.mjs'], env: { DATABASE_URL: { service: 'db' } } },
    seed: { type: 'job', run: 'once', cwd: directory, command: [process.execPath, 'seed.mjs'], dependsOn: ['migrate'], env: { DATABASE_URL: { service: 'db' }, TEST_TOKEN: { secret: 'disposable/jobs-seed' } } },
    api: { type: 'command', cwd: directory, command: [process.execPath, 'api.mjs'], dependsOn: ['seed'], readyPath: '/health', env: { DATABASE_URL: { service: 'db' }, CORS_ORIGIN: { browserUrl: 'web' } } },
    web: { type: 'command', cwd: directory, command: [process.execPath, 'web.mjs'], env: { API_URL: { service: 'api' } } },
  } };
  return { directory, spec, keys, options, get runtime() { return runtime; }, async reconnect() { await runtime.close(); runtime = await createPreviewRuntime(options); } };
}

test('real PostgreSQL jobs: startup, retained seeds, replacement, explicit rerun, owner restart and reset', database, async t => {
  const f = await databaseFixture(t);
  let ready = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal((await rows(ready.url!)).length, 1);
  assert.ok(!(await f.runtime.logs(f.spec.name)).text.includes('fake-job-secret-value'));
  assert.equal((await rows(ready.url!, 'POST')).length, 2);
  const replaced = await outcome(f.runtime, await f.runtime.replace(f.spec.name, f.spec), t.signal);
  assert.equal(replaced.state, 'ready', JSON.stringify(replaced)); assert.equal(replaced.services?.seed.state, 'skipped');
  assert.equal((await rows(replaced.url!)).length, 2);
  // A replacement can keep the old app serving, but cannot undo a job's writes.
  const migration = await readFile(join(f.directory, 'migrate.mjs'), 'utf8');
  await writeFile(join(f.directory, 'migrate.mjs'), `process.exit(8);`);
  const failed = await outcome(f.runtime, await f.runtime.replace(f.spec.name, f.spec), t.signal); assert.equal(failed.state, 'failed');
  assert.equal((await rows(replaced.url!)).length, 2);
  const stopped = await f.runtime.stop(f.spec.name);
  await writeFile(join(f.directory, 'migrate.mjs'), migration);
  ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, stopped.latest!.id, 'seed'), t.signal);
  assert.equal(ready.state, 'ready', JSON.stringify(ready)); assert.equal((await rows(ready.url!)).length, 3);
  await f.reconnect();
  ready = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(ready.services?.seed.state, 'skipped'); assert.equal((await rows(ready.url!)).length, 3);
  await f.runtime.stop(f.spec.name); await f.runtime.deleteData(f.spec.name);
  ready = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(ready.services?.seed.state, 'succeeded'); assert.equal((await rows(ready.url!)).length, 1);
});

test('failed and canceled seeds retain partial writes and block implicit retries across owner restart', database, async t => {
  const f = await databaseFixture(t);
  await writeFile(join(f.directory, 'mode'), 'fail');
  let failed = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal(failed.services?.seed.state, 'failed'); assert.match(failed.services.seed.error!.message, /9/);
  await writeFile(join(f.directory, 'mode'), ''); await f.reconnect();
  failed = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(failed.state, 'failed');
  assert.match(failed.services!.seed.error!.message, /explicitly rerun/);
  let ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, failed.id, 'seed'), t.signal);
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(((await (await fetch(ready.url!)).json()) as unknown[]).length, 2, 'partial seed was not rolled back');
  const stopped = await f.runtime.stop(f.spec.name);
  await writeFile(join(f.directory, 'mode'), 'wait');
  const starting = await f.runtime.rerunJob(f.spec.name, stopped.latest!.id, 'seed');
  await seedWaiting(f, starting, t.signal);
  await f.runtime.cancel(f.spec.name, starting.candidate!.id); await f.reconnect();
  await writeFile(join(f.directory, 'mode'), '');
  failed = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(failed.state, 'failed');
  assert.match(failed.services!.seed.error!.message, /explicitly rerun/);
  ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, failed.id, 'seed'), t.signal);
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(((await (await fetch(ready.url!)).json()) as unknown[]).length, 4, 'failed and canceled writes both remain');
});

test('a script reporting success cannot mask a database-querying readiness failure', database, async t => {
  const f = await databaseFixture(t);
  await writeFile(join(f.directory, 'migrate.mjs'), `try {throw new Error('swallowed');}catch{};`);
  delete f.spec.services.seed;
  if (f.spec.services.api.type === 'command') { f.spec.services.api.dependsOn = ['migrate']; f.spec.services.api.timeoutMs = 1000; }
  const result = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal);
  assert.equal(result.services?.migrate.state, 'succeeded');
  assert.equal(result.state, 'failed'); assert.equal(result.services?.api.state, 'failed');
});


test('owner crash leaves an in-flight seed blocked until explicit recovery', database, async t => {
  const f = await databaseFixture(t);
  await f.runtime.close();
  await writeFile(join(f.directory, 'mode'), 'wait');
  const childFile = join(f.directory, 'owner.mjs');
  await writeFile(childFile, f.keys.installSource + `
    import {createPreviewRuntime} from ${JSON.stringify(new URL('./runtime.js', import.meta.url).href)};
    import {PreviewError} from ${JSON.stringify(new URL('./errors.js', import.meta.url).href)};
    const runtime = await createPreviewRuntime({...${JSON.stringify(f.options)},authorize:()=>true});
    const started = await runtime.start(${JSON.stringify(f.spec)});
    for (;;) {
      let result;
      try { result = await runtime.wait(started.name, started.candidate.id, {timeoutMs:1000}); }
      catch (error) { if (error instanceof PreviewError && error.code === 'TIMEOUT') continue; throw error; }
      await runtime.close();
      throw new Error(JSON.stringify(result));
    }
  `);
  const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.setEncoding('utf8').on('data', text => { error = (error + text).slice(-4096); });
  const exited = once(child, 'exit');
  try {
    await until(() => {
      assert.equal(child.exitCode, null, error);
      assert.equal(child.signalCode, null, error);
      return access(join(f.directory, 'waiting')).then(() => true, () => false);
    }, t.signal);
  } finally { child.kill('SIGKILL'); await exited; }
  await f.reconnect();
  await writeFile(join(f.directory, 'mode'), '');
  const blocked = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal);
  assert.equal(blocked.state, 'failed', JSON.stringify(blocked));
  assert.match(blocked.services!.seed.error!.message, /explicitly rerun/);
  const recovered = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, blocked.id, 'seed'), t.signal);
  assert.equal(recovered.state, 'ready', JSON.stringify(recovered));
  assert.equal(((await (await fetch(recovered.url!)).json()) as unknown[]).length, 2);
});

test('real process logs preserve redaction, source selection, bounded output and attempt isolation', native, async t => {
  const directory = await folder(t);
  const keys = await testKeystore(t);
  const secret = 'FAKE_split_process_secret';
  await keys.store.add('user', 'disposable/logs', secret);
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], secretIds: ['disposable/logs'], authorize: () => true });
  t.after(() => runtime.close());
  const spec: Spec = { name: 'output', type: 'environment', primary: 'api', services: {
    prepare: { ...job(directory, `process.stdout.write('[api] job only\\n'+process.env.TOKEN.slice(0,8));setTimeout(()=>{process.stdout.write(process.env.TOKEN.slice(8)+'\\n');process.stderr.write('job stderr\\n');},30);`), env: { TOKEN: { secret: 'disposable/logs' } } },
    api: { type: 'command', cwd: directory, command: [process.execPath, '-e', `require('http').createServer((req,res)=>{if(req.url==='/write')console.log('later output');res.end('ok');}).listen(Number(process.env.PORT),process.env.HOST,()=>console.log('[prepare] api only'));`], dependsOn: ['prepare'] },
  } };
  const ready = await outcome(runtime, await runtime.start(spec), t.signal); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  const all = await runtime.logs(spec.name, ready.id);
  const prepare = await runtime.logs(spec.name, ready.id, { source: 'prepare' });
  const api = await runtime.logs(spec.name, ready.id, { source: 'api' });
  assert.match(prepare.text, /\[api\] job only/); assert.match(prepare.text, /job stderr/); assert.match(prepare.text, /REDACTED/);
  assert.ok(!prepare.text.includes(secret)); assert.ok(!all.text.includes(secret)); assert.ok(!prepare.text.includes('api only'));
  assert.match(api.text, /\[prepare\] api only/); assert.ok(!api.text.includes('job only'));
  await fetch(ready.url! + '/write');
  await until(async () => (await runtime.logs(spec.name, ready.id, { source: 'api', after: api.cursor })).text.includes('later output'));
  await assert.rejects(runtime.logs(spec.name, undefined, { after: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(runtime.logs(spec.name, ready.id, { source: 'absent' }), { code: 'INVALID_INPUT' });
  const replacement: Spec = { ...spec, services: { ...spec.services, prepare: job(directory, "console.log('failed replacement');process.exit(7)") } };
  const failed = await outcome(runtime, await runtime.replace(spec.name, replacement), t.signal); assert.equal(failed.state, 'failed');
  assert.ok(!(await runtime.logs(spec.name, failed.id, { source: 'api' })).text.includes('api only'));
  assert.match((await runtime.logs(spec.name, failed.id, { source: 'prepare' })).text, /failed replacement/);
  assert.ok(!(await runtime.logs(spec.name, ready.id)).text.includes('failed replacement'));
  await runtime.stop(spec.name);
  const flood = await outcome(runtime, await runtime.start({ ...spec, services: { prepare: job(directory, "process.stdout.write('x'.repeat(100000)+'🙂tail');"), web: { type: 'static', directory, dependsOn: ['prepare'] } }, primary: 'web' }), t.signal);
  assert.equal(flood.state, 'ready');
  const bounded = await runtime.logs(spec.name, flood.id, { source: 'prepare' });
  assert.equal(bounded.truncated, true); assert.ok(Buffer.byteLength(bounded.text) <= 65536); assert.ok(bounded.text.includes('🙂tail'));
});


async function dashboardFixture(t: test.TestContext, authorize: RuntimeOptions['authorize']) {
  const f = await databaseFixture(t, authorize);
  const { startDaemon } = await import('./daemon.js');
  const { startDashboard } = await import('./dashboard.js');
  const tokenFile = join(f.directory, 'owner', 'token');
  const owner = { projectDirectory: f.directory, pid: process.pid, allowedRoots: [f.directory], allowExec: true, inputKeys: [], secretIds: ['disposable/jobs-seed'] };
  const daemon = await startDaemon({ runtime: f.runtime, tokenFile, port: 0, owner });
  let launch = '';
  const id = 'a'.repeat(64);
  const dashboard = await startDashboard({ discover: async () => [{ id, tokenFile, connection: { endpoint: daemon.endpoint, pid: process.pid, projectDirectory: f.directory } }], openBrowser: async url => { launch = url; } });
  t.after(async () => { await dashboard.close(); await daemon.close(); });
  await dashboard.open();
  const post = async (body: object) => {
    const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: { 'content-type': 'application/json', origin: dashboard.endpoint, authorization: 'Bearer ' + new URL(launch).hash.slice(1) }, body: JSON.stringify(body) });
    return await response.json() as { result: PreviewStatus; error?: { code: string; message: string } };
  };
  const resetRequest = async () => {
    const p = await f.runtime.get(f.spec.name);
    return { action: 'resetData', owner: id, name: p.name, resources: p.data!.resources, expected: { active: p.active?.id ?? null, candidate: p.candidate?.id ?? null, latest: p.latest!.id } };
  };
  return { f, id, post, resetRequest };
}

async function rows(url: string, method = 'GET') {
  return await (await fetch(url, { method })).json() as unknown[];
}

test('dashboard reset enforces authorization, stale and concurrent guards, and environment isolation', database, async t => {
  let allowDelete = true; let deletionRequests = 0;
  const { f, id, post, resetRequest } = await dashboardFixture(t, request => {
    if (request.operation === 'delete-data') { deletionRequests++; return allowDelete; }
    return true;
  });
  try {
    let ready = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal); assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.equal((await rows(ready.url!, 'POST')).length, 2);
    const other = await outcome(f.runtime, await f.runtime.start({ ...f.spec, name: 'other-data' }), t.signal);
    assert.equal(other.state, 'ready', JSON.stringify(other));
    assert.equal((await rows(other.url!, 'POST')).length, 2);
    // Missing confirmation and stale attempts cannot stop the running preview.
    assert.equal((await post({ action: 'resetData', owner: id, name: f.spec.name })).error?.code, 'INVALID_INPUT');
    const stale = await resetRequest(); stale.expected.active = 'stale';
    assert.equal((await post(stale)).error?.code, 'STALE_ATTEMPT');
    assert.equal((await rows(ready.url!)).length, 2);
    const wrongResources = await resetRequest(); wrongResources.resources = [{ name: 'another-database', type: 'postgres' }];
    assert.equal((await post(wrongResources)).error?.code, 'STALE_ATTEMPT');
    assert.equal(deletionRequests, 0);
    assert.ok((await f.runtime.get(f.spec.name)).data);
    allowDelete = false;
    const denied = await post(await resetRequest()); assert.equal(denied.error?.code, 'EXECUTION_DENIED');
    const stopped = await f.runtime.get(f.spec.name);
    assert.ok(!stopped.active && !stopped.candidate); assert.ok(stopped.data);
    allowDelete = true;
    ready = await outcome(f.runtime, await f.runtime.startAgain(f.spec.name, stopped.latest!.id), t.signal);
    assert.equal((await rows(ready.url!)).length, 2, 'denied deletion retained data');
    // Stop retains the serving configuration after a failed update. Reset must use it too.
    const failedUpdate: Spec = { ...f.spec, services: { ...f.spec.services, migrate: job(f.directory, 'process.exit(12)') } };
    assert.equal((await outcome(f.runtime, await f.runtime.replace(f.spec.name, failedUpdate), t.signal)).state, 'failed');
    // Concurrent confirmations of the same serving attempt cannot delete twice.
    const request = await resetRequest(); const prior = deletionRequests;
    const simultaneous = await Promise.all([post(request), post(request)]);
    assert.equal(simultaneous.filter(response => !response.error).length, 1);
    assert.equal(deletionRequests, prior + 1);
    ready = await outcome(f.runtime, simultaneous.find(response => !response.error)!.result, t.signal);
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.equal(ready.services?.seed.state, 'succeeded'); assert.equal((await rows(ready.url!)).length, 1);
    assert.equal((await rows(other.url!)).length, 2, 'other environment is untouched');
    assert.equal(await f.keys.store.get('user', 'disposable/jobs-seed'), 'fake-job-secret-value');
  } finally { allowDelete = true; }
});


test('dashboard reset requires explicit recovery after deletion, startup and cancellation failures', database, async t => {
  let lockDeletion = true; let deletionRequests = 0;
  const { f, id, post, resetRequest } = await dashboardFixture(t, async request => {
    if (request.operation === 'delete-data') {
      deletionRequests++;
      if (lockDeletion) { lockDeletion = false; await f.keys.control('lock'); }
    }
    return true;
  });
  try {
    const ready = await outcome(f.runtime, await f.runtime.start(f.spec), t.signal);
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.equal((await rows(ready.url!, 'POST')).length, 2);
    const migration = await readFile(join(f.directory, 'migrate.mjs'), 'utf8');
    await writeFile(join(f.directory, 'migrate.mjs'), "console.error('deliberate migration failure');process.exit(6);");
    // Volume deletion can succeed before keystore cleanup fails. Startup must not begin.
    const interrupted = await post(await resetRequest());
    assert.equal(interrupted.error?.code, 'SECRET_STORE_UNAVAILABLE');
    const stopped = await f.runtime.get(f.spec.name);
    assert.equal(stopped.data?.cleanup?.operation, 'remove-credential');
    assert.ok(!stopped.active && !stopped.candidate);
    assert.equal(deletionRequests, 1);
    await f.keys.control('unlock');
    const recovered = await post(await resetRequest()); assert.equal(recovered.error, undefined);
    // After explicit deletion recovery, a migration failure must not trigger another reset.
    const failed = await outcome(f.runtime, recovered.result, t.signal);
    assert.equal(failed.state, 'failed', JSON.stringify(failed));
    assert.equal(failed.services?.migrate.state, 'failed');
    assert.equal(deletionRequests, 2);
    const selected = await post({ action: 'logs', owner: id, name: f.spec.name, attemptId: failed.id, source: 'migrate' }) as unknown as { result: { text: string } };
    assert.match(selected.result.text, /deliberate migration failure/);
    await writeFile(join(f.directory, 'migrate.mjs'), migration);
    const retry = await post({ action: 'startAgain', owner: id, name: f.spec.name, attemptId: failed.id });
    const restarted = await outcome(f.runtime, retry.result, t.signal);
    assert.equal(restarted.state, 'ready', JSON.stringify(restarted));
    assert.equal((await rows(restarted.url!)).length, 1);
    assert.equal(deletionRequests, 2, 'startup recovery does not delete again');
    assert.equal(await f.keys.store.get('user', 'disposable/jobs-seed'), 'fake-job-secret-value');
    // Reuse retained data to verify that cancellation blocks reset.
    const canceledBase = await f.runtime.stop(f.spec.name);
    await writeFile(join(f.directory, 'mode'), 'wait');
    const pending = await f.runtime.rerunJob(f.spec.name, canceledBase.latest!.id, 'seed');
    await seedWaiting(f, pending, t.signal);
    await f.runtime.cancel(f.spec.name, pending.candidate!.id);
    const previousDeletes = deletionRequests;
    assert.equal((await post(await resetRequest())).error?.code, 'STALE_ATTEMPT');
    assert.equal(deletionRequests, previousDeletes, 'cannot erase data without a restartable configuration');
    assert.ok((await f.runtime.get(f.spec.name)).data);
  } finally { await f.keys.control('unlock'); }
});
