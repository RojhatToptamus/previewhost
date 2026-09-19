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
import type { PreviewSpec, PreviewStatus } from './contracts.js';
import { testKeychain } from './testSupport/keychain.js';

type Spec = Extract<PreviewSpec, { type: 'environment' }>;
const native = { skip: process.platform !== 'darwin', timeout: 30_000 };
const dockerSocket = process.env.PREVIEWD_TEST_DOCKER_SOCKET;
const database = { skip: process.platform !== 'darwin' || !dockerSocket, timeout: 120_000 };
async function outcome(runtime: PreviewRuntime, started: PreviewStatus) {
  for (;;) {
    const result = await runtime.wait(started.name, started.candidate!.id);
    if (result.state !== 'starting') return result;
  }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Condition did not become true'); await delay(20); }
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
  assert.equal((await outcome(runtime, await runtime.start(spec))).error?.code, 'EXECUTION_DENIED');
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
    const ready = await outcome(runtime, await runtime.start(spec));
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.equal(ready.services?.prepare.state, 'succeeded');
    assert.equal(await (await fetch(ready.url!)).text(), 'ready');
    assert.match((await runtime.logs(spec.name)).text, /final output/);
    await runtime.stop(spec.name);
  }
  if (spec.services.prepare.type === 'job') spec.services.prepare.command = [process.execPath, '-e', 'console.error("migration failed"); process.exit(7)'];
  const failed = await outcome(runtime, await runtime.start(spec));
  assert.equal(failed.state, 'failed'); assert.equal(failed.services?.prepare.state, 'failed');
  assert.notEqual(failed.services?.web.state, 'ready');
  assert.match((await runtime.logs(spec.name)).text, /migration failed/);
  if (spec.services.prepare.type === 'job') spec.services.prepare.command = [process.execPath, '-e', 'process.exit(0)'];
  const fixed = await outcome(runtime, await runtime.start(spec)); assert.equal(fixed.state, 'ready');
  await assert.rejects(runtime.rerunJob(spec.name, fixed.id, 'prepare'), { code: 'BUSY' });
  const stopped = await runtime.stop(spec.name);
  assert.equal((await outcome(runtime, await runtime.rerunJob(spec.name, stopped.latest!.id, 'prepare'))).state, 'ready');
  await assert.rejects(runtime.rerunJob(spec.name, failed.id, 'prepare'), { code: 'ATTEMPT_EXPIRED' });
});

test('timeout and cancellation stop job process groups before startup returns', native, async t => {
  const directory = await folder(t);
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true }); t.after(() => runtime.close());
  const script = `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync('pids',process.pid+' '+child.pid); setInterval(()=>{},1000)`;
  const spec: Spec = { name: 'cancel-jobs', type: 'environment', primary: 'web', services: {
    slow: { ...job(directory, script), timeoutMs: 1000 }, web: { type: 'static', directory, dependsOn: ['slow'] },
  } };
  const failed = await outcome(runtime, await runtime.start(spec));
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

async function databaseFixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-jobs-')));
  let runtime: PreviewRuntime;
  t.after(async () => {
    if (runtime) { for (const p of await runtime.list()) { await runtime.stop(p.name); if (p.data) await runtime.deleteData(p.name); } await runtime.close(); }
    await rm(directory, { recursive: true, force: true });
  });
  const keys = await testKeychain(t);
  await keys.store.add('user', 'disposable/jobs-seed', 'fake-job-secret-value');
  const options = { allowedRoots: [directory], dataDirectory: join(directory, 'data'), dockerSocket, secretIds: ['disposable/jobs-seed'], authorize: () => true };
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
  let ready = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  const rows = async (url: string, method = 'GET') => (await (await fetch(url, { method })).json()) as unknown[];
  assert.equal((await rows(ready.url!)).length, 1);
  assert.ok(!(await f.runtime.logs(f.spec.name)).text.includes('fake-job-secret-value'));
  assert.equal((await rows(ready.url!, 'POST')).length, 2);
  const replaced = await outcome(f.runtime, await f.runtime.replace(f.spec.name, f.spec));
  assert.equal(replaced.state, 'ready', JSON.stringify(replaced)); assert.equal(replaced.services?.seed.state, 'skipped');
  assert.equal((await rows(replaced.url!)).length, 2);
  // A replacement can keep the old app serving, but cannot undo a job's writes.
  await writeFile(join(f.directory, 'migrate.mjs'), `process.exit(8);`);
  const failed = await outcome(f.runtime, await f.runtime.replace(f.spec.name, f.spec)); assert.equal(failed.state, 'failed');
  assert.equal((await rows(replaced.url!)).length, 2);
  const stopped = await f.runtime.stop(f.spec.name);
  await writeFile(join(f.directory, 'migrate.mjs'), `console.log('migration already applied');`);
  ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, stopped.latest!.id, 'seed'));
  assert.equal(ready.state, 'ready', JSON.stringify(ready)); assert.equal((await rows(ready.url!)).length, 3);
  await f.reconnect();
  ready = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(ready.services?.seed.state, 'skipped'); assert.equal((await rows(ready.url!)).length, 3);
  await f.runtime.stop(f.spec.name); await f.runtime.deleteData(f.spec.name);
  // Reinstall the migration for the newly empty database.
  await writeFile(join(f.directory, 'migrate.mjs'), `import {Client} from ${JSON.stringify(import.meta.resolve('pg'))};const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();await db.query('CREATE TABLE items (id serial primary key,label text)');await db.end();`);
  ready = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(ready.services?.seed.state, 'succeeded'); assert.equal((await rows(ready.url!)).length, 1);
});

test('failed and canceled seeds retain partial writes and block implicit retries across owner restart', database, async t => {
  const f = await databaseFixture(t);
  await writeFile(join(f.directory, 'mode'), 'fail');
  let failed = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal(failed.services?.seed.state, 'failed'); assert.match(failed.services.seed.error!.message, /9/);
  await writeFile(join(f.directory, 'mode'), ''); await f.reconnect();
  failed = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(failed.state, 'failed');
  assert.match(failed.services!.seed.error!.message, /explicitly rerun/);
  let ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, failed.id, 'seed'));
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(((await (await fetch(ready.url!)).json()) as unknown[]).length, 2, 'partial seed was not rolled back');
  await f.runtime.stop(f.spec.name); await f.runtime.deleteData(f.spec.name);
  await writeFile(join(f.directory, 'mode'), 'wait');
  const starting = await f.runtime.start(f.spec);
  await until(() => access(join(f.directory, 'waiting')).then(() => true, () => false));
  await f.runtime.cancel(f.spec.name, starting.candidate!.id); await f.reconnect();
  await writeFile(join(f.directory, 'mode'), '');
  failed = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(failed.state, 'failed');
  assert.match(failed.services!.seed.error!.message, /explicitly rerun/);
  ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, failed.id, 'seed'));
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(((await (await fetch(ready.url!)).json()) as unknown[]).length, 2);
});

test('a script reporting success cannot mask a database-querying readiness failure', database, async t => {
  const f = await databaseFixture(t);
  await writeFile(join(f.directory, 'migrate.mjs'), `try {throw new Error('swallowed');}catch{};`);
  delete f.spec.services.seed;
  if (f.spec.services.api.type === 'command') { f.spec.services.api.dependsOn = ['migrate']; f.spec.services.api.timeoutMs = 1000; }
  const result = await outcome(f.runtime, await f.runtime.start(f.spec));
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
    const runtime = await createPreviewRuntime({...${JSON.stringify(f.options)},authorize:()=>true});
    await runtime.start(${JSON.stringify(f.spec)});
    setInterval(()=>{},1000);
  `);
  const child = spawn(process.execPath, [childFile], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    await until(() => access(join(f.directory, 'waiting')).then(() => true, () => false));
  } finally { child.kill('SIGKILL'); await exited; }
  await f.reconnect();
  await writeFile(join(f.directory, 'mode'), '');
  const blocked = await outcome(f.runtime, await f.runtime.start(f.spec));
  assert.equal(blocked.state, 'failed', JSON.stringify(blocked));
  assert.match(blocked.services!.seed.error!.message, /explicitly rerun/);
  const recovered = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, blocked.id, 'seed'));
  assert.equal(recovered.state, 'ready', JSON.stringify(recovered));
  assert.equal(((await (await fetch(recovered.url!)).json()) as unknown[]).length, 2);
});
