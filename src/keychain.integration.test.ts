import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { keychain, Keychain } from './keychain.js';
import { Keystore } from './keystore.js';
import { testKeychain } from './testSupport/keychain.js';
import { failure } from './errors.js';

const enabled = { skip: process.platform !== 'darwin', timeout: 60_000 };
const invoke = Keychain.prototype.invoke;
const execute = promisify(execFile);

// Keep real Keychain fixtures in this file: creation temporarily changes the user's search list.
test('macOS remembers one unlock key; forgetting affects new sessions, not active owners', { skip: process.platform !== 'darwin' }, async t => {
  const native = await testKeychain(t);
  const directory = join(native.directory, 'vault');
  const stores: Keystore[] = [];
  const session = () => { const store = new Keystore(directory); stores.push(store); return store; };
  t.mock.method(keychain, 'get', (...args: Parameters<Keychain['get']>) => Keychain.prototype.get.call(native.store, ...args));
  try {
    const store = session();
    const password = 'FAKE_correct_password';
    await store.unlock({ password, create: true, confirmation: password });
    await store.remember();
    const second = session(); assert.equal((await second.status()).state, 'unlocked');
    await native.control('lock');
    assert.equal((await session().status()).state, 'locked');
    await store.set('user','still-open','FAKE_value');
    await native.control('unlock');
    await store.forget();
    assert.equal((await session().status()).state, 'locked');
    assert.equal(await second.get('user','still-open'),'FAKE_value');
  } finally { stores.forEach(store => store.close()); }
});

test('Keychain remembers only unlock keys, preserves no-UI failures and updates in place', enabled, async t => {
  const fixture = await testKeychain(t), store = fixture.store;
  const value = 'a'.repeat(64);
  assert.equal(await store.get('unlock', 'missing'), undefined);
  assert.equal(await store.add('unlock', 'vault', value), true);
  assert.equal(await store.add('unlock', 'vault', 'b'.repeat(64)), false);
  assert.equal(await store.get('unlock', 'vault'), value);
  await fixture.control('lock');
  await assert.rejects(store.get('unlock', 'vault'), { code: 'SECRET_STORE_UNAVAILABLE' });
  await fixture.control('unlock');
  const copied = join(fixture.directory, 'copied-helper');
  await copyFile(fixture.helper, copied);
  const copiedStore = new Keychain(copied, [fixture.path]);
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.previewhost.denied-fixture', copied]);
  const denied = await invoke.call(copiedStore, { operation: 'get', namespace: 'unlock', id: 'vault' });
  assert.ok([-25293, -25308, -25315].includes(denied.status));
  assert.equal(denied.data, undefined);
  assert.equal(await store.update('unlock', 'vault', 'b'.repeat(64)), true);
  assert.equal(await store.get('unlock', 'vault'), 'b'.repeat(64));
  await store.remove('unlock', 'vault');
  assert.equal(await store.get('unlock', 'vault'), undefined);
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
  const writing = invoke.call(store, { operation: 'add', namespace: 'unlock', id: 'late', value: 'FAKE_committed' }, { signal: controller.signal });
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
  const requests = Array.from({ length: 36 }, () => invoke.call(store, { operation: 'get', namespace: 'unlock', id: 'queued' }, { signal: cancel.signal }));
  const settled = Promise.allSettled(requests);
  await assert.rejects(invoke.call(store, { operation: 'get', namespace: 'unlock', id: 'overflow' }), { code: 'BUSY' });
  cancel.abort();
  assert.ok((await settled).every((result) => result.status === 'rejected'));
  assert.equal(await fixture.store.get('unlock', 'absent'), undefined);
  const unavailable = new Keychain(join(fixture.directory, 'absent-helper'));
  await assert.rejects(invoke.call(unavailable, { operation: 'get', namespace: 'unlock', id: 'absent' }), { code: 'SECRET_STORE_UNAVAILABLE' });
});
