import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import type { PreviewSpec, PreviewStatus, RuntimeOptions } from './contracts.js';
import { PreviewError } from './errors.js';

const dockerSocket = process.env.PREVIEWHOST_TEST_DOCKER_SOCKET;
async function settle(runtime: PreviewRuntime, status: PreviewStatus, signal: AbortSignal) {
  for (;;) {
    try { return await runtime.wait(status.name, status.candidate!.id, { signal }); }
    catch (error) {
      // A wait window can expire while the same attempt is still running. The test deadline bounds observation.
      if (error instanceof PreviewError && error.code === 'TIMEOUT') continue;
      throw new Error(JSON.stringify({ status: await runtime.get(status.name), logs: await runtime.logs(status.name, status.candidate!.id) }), { cause: error });
    }
  }
}

test('Compose replacements, failures, cancellation and restart keep exact volume ownership and isolate another environment', {
  skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET and local busybox:1.37', timeout: 180000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const options: RuntimeOptions = { allowedRoots: [source], dataDirectory: join(directory, 'data'), stateDirectory: join(directory, 'state'),
    keystoreDirectory: join(directory, 'keystore'), dockerSocket, authorize: () => true };
  let runtime = await createPreviewRuntime(options);
  t.after(async () => {
    for (const status of await runtime.list()) {
      await runtime.stop(status.name);
      if ((await runtime.get(status.name)).data) await runtime.deleteData(status.name);
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const write = async (value: string, fail = false, wait = false) => writeFile(join(source, 'compose.json'), JSON.stringify({
    services: { web: { image: 'busybox:1.37', command: ['sh', '-c', 'if [ "$$FAIL" = yes ]; then exit 9; fi; if [ "$$WAIT" = yes ]; then sleep 120; fi; if [ ! -f /data/index.html ]; then echo "$$VALUE" > /data/index.html; fi; echo "app-log:$$TOKEN"; exec httpd -f -p 8080 -h /data'],
      expose: [8080], environment: { VALUE: value, FAIL: fail ? 'yes' : 'no', WAIT: wait ? 'yes' : 'no', TOKEN: 'SYNTHETIC_COMPOSE_PRIVATE_VALUE_2026' }, volumes: ['notes:/data'] } },
    volumes: { notes: {} },
  }));
  const spec = (name: string): PreviewSpec => ({ name, type: 'compose', cwd: source, files: ['compose.json'], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } }, ready: { type: 'http', port: 'http', path: '/', timeoutMs: 3000 } }],
    primary: { service: 'web', port: 'http' }, timeoutMs: 20000 });
  await write('first');
  const first = await settle(runtime, await runtime.start(spec('one')), t.signal);
  assert.equal(first.state, 'ready', JSON.stringify({ result: first, logs: await runtime.logs('one', first.id) }));
  assert.equal((await (await fetch(first.url!)).text()).trim(), 'first');
  await write('second');
  const second = await settle(runtime, await runtime.start(spec('two')), t.signal);
  assert.equal(second.state, 'ready', JSON.stringify(second));
  assert.equal((await (await fetch(second.url!)).text()).trim(), 'second');
  const replacement = await settle(runtime, await runtime.replace('one', spec('one')), t.signal);
  assert.equal(replacement.state, 'ready', JSON.stringify(replacement));
  assert.equal(replacement.url, first.url);
  assert.equal((await (await fetch(replacement.url!)).text()).trim(), 'first');
  assert.doesNotMatch(JSON.stringify(await runtime.describe('one', replacement.id)), /SYNTHETIC_COMPOSE_PRIVATE_VALUE_2026/);
  const deadline = Date.now() + 5000;
  while (!(await runtime.logs('one', replacement.id, { source: 'web' })).text.includes('app-log:')) { assert.ok(Date.now() < deadline, 'Container output was not captured'); await delay(25); }
  assert.match((await runtime.logs('one', replacement.id, { source: 'web' })).text, /app-log:\[REDACTED\]/);
  assert.doesNotMatch((await runtime.logs('one', replacement.id)).text, /SYNTHETIC_COMPOSE_PRIVATE_VALUE_2026/);
  await write('ignored', true);
  const failed = await settle(runtime, await runtime.replace('one', spec('one')), t.signal);
  assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal((await runtime.get('one')).active, undefined, 'An in-place data update must not claim the stopped application still serves');
  assert.equal((await fetch(second.url!)).status, 200);
  await write('ignored', false, true);
  const candidate = await runtime.start(spec('one'));
  const cancelDeadline = Date.now() + 10000;
  while (!(await runtime.logs('one', candidate.candidate!.id)).text.includes('Started')) { assert.ok(Date.now() < cancelDeadline, 'The candidate container did not start'); await delay(50); }
  await runtime.cancel('one', candidate.candidate!.id);
  assert.equal((await runtime.get('one')).latest?.state, 'canceled');
  await write('ignored');
  await runtime.close();
  runtime = await createPreviewRuntime(options);
  assert.equal((await runtime.get('two')).active, undefined);
  const restarted = await settle(runtime, await runtime.start(spec('one')), t.signal);
  assert.equal(restarted.state, 'ready', JSON.stringify(restarted));
  assert.equal((await (await fetch(restarted.url!)).text()).trim(), 'first');
  await runtime.stop('one');
  await runtime.deleteData('one');
  assert.equal((await runtime.get('one')).data, undefined);
  assert.deepEqual((await runtime.get('two')).data?.resources, [{ name: 'notes', type: 'compose-volume' }]);
});
