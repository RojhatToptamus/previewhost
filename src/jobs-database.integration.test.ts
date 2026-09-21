import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { traceStep } from './testSupport/diagnosis.js';
import { database, databaseFixture, outcome, rows, seedWaiting, until } from './testSupport/jobs.js';

test('real PostgreSQL jobs: startup, retained seeds, replacement, explicit rerun, owner restart and reset', database, async t => {
  const f = await databaseFixture(t);
  let ready = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal((await rows(ready.url!)).length, 1);
  assert.ok(!(await f.runtime.logs(f.spec.name)).text.includes('fake-job-secret-value'));
  assert.equal((await rows(ready.url!, 'POST')).length, 2);
  const replaced = await outcome(f.runtime, await f.runtime.replace(f.spec.name, f.spec));
  assert.equal(replaced.state, 'ready', JSON.stringify(replaced)); assert.equal(replaced.services?.seed.state, 'skipped');
  assert.equal((await rows(replaced.url!)).length, 2);
  // A replacement can keep the old app serving, but cannot undo a job's writes.
  const migration = await readFile(join(f.directory, 'migrate.mjs'), 'utf8');
  await writeFile(join(f.directory, 'migrate.mjs'), `process.exit(8);`);
  const failed = await outcome(f.runtime, await f.runtime.replace(f.spec.name, f.spec)); assert.equal(failed.state, 'failed');
  assert.equal((await rows(replaced.url!)).length, 2);
  const stopped = await f.runtime.stop(f.spec.name);
  await writeFile(join(f.directory, 'migrate.mjs'), migration);
  ready = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, stopped.latest!.id, 'seed'));
  assert.equal(ready.state, 'ready', JSON.stringify(ready)); assert.equal((await rows(ready.url!)).length, 3);
  await f.reconnect();
  ready = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(ready.services?.seed.state, 'skipped'); assert.equal((await rows(ready.url!)).length, 3);
  await f.runtime.stop(f.spec.name); await f.runtime.deleteData(f.spec.name);
  ready = await outcome(f.runtime, await f.runtime.start(f.spec)); assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(ready.services?.seed.state, 'succeeded'); assert.equal((await rows(ready.url!)).length, 1);
});

test('failed and canceled seeds retain partial writes and block implicit retries across owner restart', database, async t => {
  const f = await traceStep('seed recovery 01 fixture', () => databaseFixture(t));
  await traceStep('seed recovery 02 select failure', () => writeFile(join(f.directory, 'mode'), 'fail'));
  let failed = await traceStep('seed recovery 03 failed initial start', async () => outcome(f.runtime, await f.runtime.start(f.spec))); assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal(failed.services?.seed.state, 'failed'); assert.match(failed.services.seed.error!.message, /9/);
  await traceStep('seed recovery 04 clear failure mode', () => writeFile(join(f.directory, 'mode'), '')); await traceStep('seed recovery 05 reconnect after failure', () => f.reconnect());
  failed = await traceStep('seed recovery 06 blocked start after failure', async () => outcome(f.runtime, await f.runtime.start(f.spec))); assert.equal(failed.state, 'failed');
  assert.match(failed.services!.seed.error!.message, /explicitly rerun/);
  let ready = await traceStep('seed recovery 07 explicit recovery after failure', async () => outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, failed.id, 'seed')));
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(((await traceStep('seed recovery 08 retained failed write', async () => (await fetch(ready.url!)).json())) as unknown[]).length, 2, 'partial seed was not rolled back');
  const stopped = await traceStep('seed recovery 09 stop', () => f.runtime.stop(f.spec.name));
  await traceStep('seed recovery 10 select waiting', () => writeFile(join(f.directory, 'mode'), 'wait'));
  const starting = await traceStep('seed recovery 11 start pending seed', () => f.runtime.rerunJob(f.spec.name, stopped.latest!.id, 'seed'));
  await traceStep('seed recovery 12 wait for seed marker', () => seedWaiting(f, starting, t.signal));
  await traceStep('seed recovery 13 cancel', () => f.runtime.cancel(f.spec.name, starting.candidate!.id)); await traceStep('seed recovery 14 reconnect after cancellation', () => f.reconnect());
  await traceStep('seed recovery 15 clear waiting mode', () => writeFile(join(f.directory, 'mode'), ''));
  failed = await traceStep('seed recovery 16 blocked start after cancellation', async () => outcome(f.runtime, await f.runtime.start(f.spec))); assert.equal(failed.state, 'failed');
  assert.match(failed.services!.seed.error!.message, /explicitly rerun/);
  ready = await traceStep('seed recovery 17 explicit recovery after cancellation', async () => outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, failed.id, 'seed')));
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(((await traceStep('seed recovery 18 retained canceled write', async () => (await fetch(ready.url!)).json())) as unknown[]).length, 4, 'failed and canceled writes both remain');
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
  const blocked = await outcome(f.runtime, await f.runtime.start(f.spec));
  assert.equal(blocked.state, 'failed', JSON.stringify(blocked));
  assert.match(blocked.services!.seed.error!.message, /explicitly rerun/);
  const recovered = await outcome(f.runtime, await f.runtime.rerunJob(f.spec.name, blocked.id, 'seed'));
  assert.equal(recovered.state, 'ready', JSON.stringify(recovered));
  assert.equal(((await (await fetch(recovered.url!)).json()) as unknown[]).length, 2);
});
