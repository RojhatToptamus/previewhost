import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Keystore, validateSecretValue } from './keystore.js';
import { keychain, Keychain } from './keychain.js';
import { testKeychain } from './testSupport/keychain.js';
import { createPreviewRuntime } from './runtime.js';
import { startDaemon } from './daemon.js';
import { SecretSetup } from './secrets-setup.js';

const password = 'FAKE_correct_password';
const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'previewhost-vault-'));
  const directory = join(root, 'private');
  const stores: Keystore[] = [];
  t.mock.method(keychain, 'get', async () => undefined);
  const session = () => { const store = new Keystore(directory); stores.push(store); return store; };
  t.after(async () => { stores.forEach(store => store.close()); await rm(root, { recursive: true, force: true }); });
  const store = session();
  await store.unlock({ password, create: true, confirmation: password });
  return { directory, store, session };
}

test('encrypted values, exact references, separate namespaces, restart and backup recovery', async t => {
  const { directory, store, session } = await fixture(t);
  const value = '\ufeffFAKE_secret_ü\nline two \n';
  await store.set('user', 'project/dev/api', value);
  await store.set('user', 'constructor', 'FAKE_constructor');
  await store.set('database', 'a'.repeat(32), 'b'.repeat(64));
  assert.equal(await store.get('user', 'project/dev/api'), value);
  assert.equal(await store.get('user', 'constructor'), 'FAKE_constructor');
  assert.equal(await store.get('user', 'toString'), undefined);
  assert.deepEqual(await store.list(), { ids: ['constructor', 'project/dev/api'], truncated: false });
  for (const invalid of ['', 'a\0b', '\ud800', '🙂'.repeat(1025)]) assert.throws(() => validateSecretValue(invalid));
  for (const file of await readdir(directory)) {
    const contents = await readFile(join(directory, file));
    assert.ok(!contents.includes(Buffer.from('FAKE_secret')) && !contents.includes(Buffer.from('project/dev/api')) && !contents.includes(Buffer.from(password)));
  }
  const second = session();
  assert.equal((await second.status()).state, 'locked');
  await assert.rejects(second.get('user', 'project/dev/api'), { code: 'SECRET_STORE_UNAVAILABLE' });
  await assert.rejects(second.unlock({ password: 'FAKE_wrong_password' }), /incorrect or.*damaged/);
  await assert.rejects(second.unlock({ password, confirmation: password, create: true }), /already exists/);
  await second.unlock({ password });
  await store.update('user', 'project/dev/api', 'FAKE_new');
  assert.equal(await second.get('user', 'project/dev/api'), 'FAKE_new');
  await second.remove('user', 'project/dev/api');
  assert.equal(await store.get('user', 'project/dev/api'), undefined);
  assert.equal(await store.update('user', 'project/dev/api', 'FAKE_no_recreate'), false);
  store.close(); second.close();
  await copyFile(join(directory, 'secrets.sqlite'), join(directory, 'backup'));
  const restored = session();
  await restored.unlock({ password });
  assert.equal(await restored.get('database', 'a'.repeat(32)), 'b'.repeat(64));
  restored.close();
  const damaged = new DatabaseSync(join(directory, 'secrets.sqlite'));
  damaged.exec('UPDATE vault SET ciphertext=zeroblob(100)'); damaged.close();
  const broken = session();
  await assert.rejects(broken.unlock({ password }), /incorrect or.*damaged/);
  broken.close();
  await copyFile(join(directory, 'backup'), join(directory, 'secrets.sqlite'));
  const reopened = session(); await reopened.unlock({ password });
  assert.equal(await reopened.get('user', 'constructor'), 'FAKE_constructor');
});

test('concurrent processes preserve independent updates and create-only semantics', { timeout: 30_000 }, async t => {
  const { store, directory } = await fixture(t);
  const source = `import {Keystore} from ${JSON.stringify(new URL('./keystore.js', import.meta.url).href)};
    const store = new Keystore(process.argv[1]); await store.unlock({password:${JSON.stringify(password)}});
    for(let i=0;i<12;i++) await store.set('user',process.argv[2]+'/'+i,'FAKE_'+i);
    console.log(await store.add('user','shared','FAKE_'+process.argv[2])); store.close();`;
  const children = await Promise.all(['owner-a','worktree-b','project-c'].map(name => execute(process.execPath, ['--input-type=module','-e',source,directory,name])));
  assert.equal(children.filter(child => child.stdout.trim() === 'true').length, 1);
  assert.equal((await store.list()).ids.length, 37);
  for (const name of ['owner-a','worktree-b','project-c']) assert.equal(await store.get('user', name+'/11'), 'FAKE_11');
});

test('concurrent initialization keeps the first keystore and lets the other owner unlock it', async t => {
  const { directory } = await fixture(t);
  const owners = [new Keystore(join(directory, 'new')), new Keystore(join(directory, 'new'))];
  try {
    const results = await Promise.allSettled(owners.map(store => store.unlock({ password, create: true, confirmation: password })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = owners[results.findIndex(result => result.status === 'fulfilled')];
    const other = owners[results.findIndex(result => result.status === 'rejected')];
    await winner.set('user', 'kept', 'FAKE_first');
    await other.unlock({ password });
    assert.equal(await other.get('user', 'kept'), 'FAKE_first');
  } finally { owners.forEach(store => store.close()); }
});

test('killed transaction rolls back, releases its lock and permits recovery', { timeout: 15_000 }, async t => {
  const { store, directory, session } = await fixture(t);
  await store.set('user','kept','FAKE_committed');
  const child = spawn(process.execPath, ['--input-type=module','-e', `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE; UPDATE vault SET ciphertext=zeroblob(100)');
    console.log('uncommitted');setInterval(()=>{},1000);`, join(directory,'secrets.sqlite')], { stdio: ['ignore','pipe','pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  await once(child.stdout!, 'data');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  store.close();
  const recovered = session(); await recovered.unlock({ password });
  assert.equal(await recovered.get('user','kept'), 'FAKE_committed');
  await recovered.set('user','after','FAKE_after');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(recovered.set('user','kept','FAKE_canceled',{signal:abort.signal}), { code:'CLOSED' });
  assert.equal(await recovered.get('user','kept'), 'FAKE_committed');
});

test('closing during password derivation cannot unlock or initialize afterward', async t => {
  const { session, directory } = await fixture(t);
  const store = session(); const unlocking = store.unlock({ password });
  store.close(); await assert.rejects(unlocking, { code: 'CLOSED' });
  assert.ok((await readFile(join(directory,'secrets.sqlite'))).length > 0);
});

test('unavailable automatic storage leaves password unlock usable and reports remember failure', async t => {
  const { store, session } = await fixture(t);
  t.mock.method(keychain, 'get', async () => { throw new Error('OS unavailable'); });
  t.mock.method(keychain, 'add', async () => { throw new Error('OS unavailable'); });
  const next = session();
  assert.equal((await next.status()).state, 'locked');
  const result = await next.unlock({ password, remember: true });
  assert.equal(result.state, 'unlocked'); assert.ok(result.warning);
  await next.set('user','usable','FAKE_value');
  assert.equal(await store.get('user','usable'),'FAKE_value');
});

test('macOS remembers one unlock key; forgetting affects new sessions, not active owners', { skip: process.platform !== 'darwin' }, async t => {
  const { store, session } = await fixture(t);
  const native = await testKeychain(t);
  t.mock.method(keychain, 'get', (...args: Parameters<Keychain['get']>) => Keychain.prototype.get.call(native.store, ...args));
  await store.remember();
  const second = session(); assert.equal((await second.status()).state, 'unlocked');
  await native.control('lock');
  assert.equal((await session().status()).state, 'locked');
  await store.set('user','still-open','FAKE_value');
  await native.control('unlock');
  await store.forget();
  assert.equal((await session().status()).state, 'locked');
  assert.equal(await second.get('user','still-open'),'FAKE_value');
});

test('private approval, password unlock, owner isolation and cancellation remain separate', async t => {
  const { store, directory } = await fixture(t);
  await store.set('user','approved/ref','FAKE_value');
  const runtimes = await Promise.all([1,2].map(() => createPreviewRuntime({ allowedRoots:[directory], authorize:()=>true })));
  // Give these owners separate sessions over the same disposable file.
  for(const runtime of runtimes) Object.defineProperty(runtime,'keystore',{value:new Keystore(directory)});
  const urls: string[] = [];
  t.mock.method(SecretSetup.prototype,'openBrowser',async (url: string) => { urls.push(url); });
  const daemon = await startDaemon({runtime:runtimes[0],tokenFile:join(directory,'owner/token'),port:0});
  t.after(async()=>{await daemon.close();await runtimes[1].close();});
  const setup = new SecretSetup(runtimes[0],daemon.endpoint);
  const spec = {name:'private',type:'command' as const,cwd:directory,command:[process.execPath,'app.mjs'],env:{APP_TOKEN:{secret:'approved/ref'}}};
  const request = await setup.setup(spec,new AbortController().signal);
  assert.equal(request.state,'pending');
  const capability='Bearer '+new URL(urls.pop()!).hash.slice(1);
  await assert.rejects(setup.unlock(capability,{password}),{code:'SECRET_DENIED'});
  const approved=await setup.approve(capability);assert.equal(approved.state,'pending');
  assert.equal((await runtimes[0].keystore.status()).state,'locked');
  await assert.rejects(setup.unlock(capability,{password:'FAKE_wrong'}));
  assert.equal(setup.status(request.id).state,'pending');
  assert.equal((await setup.unlock(capability,{password})).state,'complete');
  assert.equal((await runtimes[1].keystore.status()).state,'locked');
  assert.equal((await runtimes[1].inspect(spec)).secrets![0].selected,false);
  assert.deepEqual(await runtimes[0].list(),[]);
  await setup.close();
});
