import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Keychain, validateSecretValue } from './keychain.js';
import { listSecrets, removeSecret, setSecret } from './secrets.js';
import { testKeychain } from './testSupport/keychain.js';
import { failure } from './errors.js';

const enabled = { skip: process.platform !== 'darwin', timeout: 60_000 };
const invoke = Keychain.prototype.invoke;
const execute = promisify(execFile);

test('real Keychain preserves exact values, atomic creation, private namespaces, and no-UI access failures', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const store = fixture.store;
  const value = '\ufeffFAKE_üñîçødé\nsecond line \n';
  assert.equal(await store.get('user', 'missing'), undefined);
  assert.equal(await store.has('user', 'missing'), false);
  await setSecret('shared/sample', value);
  assert.equal(await store.get('user', 'shared/sample'), value);
  assert.deepEqual(await listSecrets(), { ids: ['shared/sample'], truncated: false });
  assert.equal(await store.update('user', 'missing', 'FAKE_other'), false);
  const race = await Promise.all([store.add('user', 'race', 'FAKE_A'), store.add('user', 'race', 'FAKE_B')]);
  assert.deepEqual(race.sort(), [false, true]);
  assert.ok(['FAKE_A', 'FAKE_B'].includes((await store.get('user', 'race'))!));
  await store.add('database', 'internal', 'FAKE_internal');
  assert.ok(!(await listSecrets()).ids.includes('internal'));
  await removeSecret('internal');
  assert.equal(await store.get('database', 'internal'), 'FAKE_internal');
  for (const invalid of ['', 'a\0b', '\ud800', '🙂'.repeat(1025)]) assert.throws(() => validateSecretValue(invalid), { code: 'INVALID_INPUT' });
  await setSecret('boundary', '🙂'.repeat(1024));
  assert.equal(Buffer.byteLength((await store.get('user', 'boundary'))!), 4096);
  await fixture.control('lock');
  await assert.rejects(store.has('user', 'shared/sample'), { code: 'SECRET_STORE_UNAVAILABLE' });
  await assert.rejects(store.get('user', 'shared/sample'), { code: 'SECRET_STORE_UNAVAILABLE' });
  await fixture.control('unlock');
  assert.equal(await store.get('user', 'shared/sample'), value);
  const copied = join(fixture.directory, 'copied-helper');
  await copyFile(fixture.helper, copied);
  const copiedStore = new Keychain(copied, [fixture.path]);
  assert.equal((await invoke.call(copiedStore, { operation: 'get', namespace: 'user', id: 'shared/sample' })).data, Buffer.from(value).toString('base64'));
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.previewd.denied-fixture', copied]);
  const denied = await invoke.call(copiedStore, { operation: 'get', namespace: 'user', id: 'shared/sample' });
  assert.ok([-25293, -25308, -25315].includes(denied.status));
  assert.equal(denied.data, undefined);
  await removeSecret('shared/sample');
  assert.equal(await store.get('user', 'shared/sample'), undefined);
  assert.equal(await store.get('database', 'internal'), 'FAKE_internal');
});

test('metadata enumeration is bounded natively and reports truncation without reading values', enabled, async (t) => {
  const { store } = await testKeychain(t);
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < 129) {
      const id = `item-${next++}`;
      await store.add('user', id, `FAKE_${id}`);
    }
  }));
  const result = await store.list();
  assert.equal(result.ids.length, 128);
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('FAKE_'));
  t.diagnostic(`129 native adds and bounded listing: ${Math.round(performance.now() - started)} ms`);
});

test('canceled helpers are reaped, queued work is bounded, and a dispatched write retains an unknown outcome', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const marker = join(fixture.directory, 'synthetic-commit.json');
  const helper = join(fixture.directory, 'delayed-helper.mjs');
  await writeFile(helper, `import fs from 'node:fs'; let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{
    const request=JSON.parse(input); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,value:request.data ? Buffer.from(request.data,'base64').toString('utf8') : undefined})); setInterval(()=>{},10000);
  });`);
  const store = new Keychain(process.execPath, [helper]);
  const controller = new AbortController();
  const writing = invoke.call(store, { operation: 'add', namespace: 'user', id: 'late', value: 'FAKE_committed' }, { signal: controller.signal });
  const failed = assert.rejects(writing, (error: unknown) => {
    assert.equal(failure(error).code, 'SECRET_STORE_UNAVAILABLE');
    assert.equal(failure(error).outcome, 'unknown');
    return true;
  });
  let committed: { pid: number; value: string } | undefined;
  for (let i = 0; i < 100 && !committed; i++) {
    try { committed = JSON.parse(await readFile(marker, 'utf8')); } catch { await pause(20); }
  }
  assert.ok(committed); controller.abort(); await failed;
  assert.equal(committed.value, 'FAKE_committed');
  assert.throws(() => process.kill(committed.pid, 0), { code: 'ESRCH' });
  const cancel = new AbortController();
  const requests = Array.from({ length: 36 }, () => invoke.call(store, { operation: 'get', namespace: 'user', id: 'queued' }, { signal: cancel.signal }));
  const settled = Promise.allSettled(requests);
  await assert.rejects(invoke.call(store, { operation: 'get', namespace: 'user', id: 'overflow' }), { code: 'BUSY' });
  cancel.abort();
  assert.ok((await settled).every((result) => result.status === 'rejected'));
  assert.equal(await fixture.store.has('user', 'absent'), false);
  const unavailable = new Keychain(join(fixture.directory, 'absent-helper'));
  await assert.rejects(invoke.call(unavailable, { operation: 'get', namespace: 'user', id: 'absent' }), { code: 'SECRET_STORE_UNAVAILABLE' });
});
