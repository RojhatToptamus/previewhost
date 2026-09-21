import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewRuntime } from './runtime.js';
import { parseSpec } from './spec.js';
import { loadPreviewSpec, savePreviewSpec } from './config.js';
import { testKeystore } from './testSupport/keystore.js';
import { job, outcome, until, type Spec } from './testSupport/jobs.js';

const native = { skip: process.platform !== 'darwin', timeout: 30_000 };
async function folder(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

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
