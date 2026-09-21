import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreviewStatus, RuntimeOptions } from './contracts.js';
import { database, databaseFixture, job, outcome, rows, seedWaiting, type Spec } from './testSupport/jobs.js';

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
