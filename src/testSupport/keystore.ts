import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Keystore } from '../keystore.js';
import { keychain } from '../keychain.js';

export const keystore = Keystore.prototype;
let active: Keystore;
export const setSecret = (id: string, value: string) => active.set('user', id, value);
export const removeSecret = (id: string) => active.remove('user', id);
const password = 'FAKE_fixture_password';

/** Real encrypted storage, with a disposable path and an already-unlocked owner session. */
export async function testKeystore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-test-keystore-'));
  const vault = join(directory, 'vault');
  const sessions = new Set<Keystore>();
  let locked = false;
  // Redirect opening only. Every read, encryption and transaction remains real.
  const prototype = Keystore.prototype as unknown as { open: (this: Keystore) => unknown };
  const open = prototype.open;
  t.mock.method(prototype, 'open', function (this: Keystore) {
    Object.defineProperty(this, 'directory', { value: vault, configurable: true });
    sessions.add(this);
    return open.call(this);
  });
  t.mock.method(keychain, 'get', async () => undefined);
  const unlocking = new WeakMap<Keystore, Promise<Awaited<ReturnType<Keystore['status']>>>>();
  const status = Keystore.prototype.status;
  t.mock.method(Keystore.prototype, 'status', async function (this: Keystore, options = {}) {
    const state = await status.call(this, options);
    if (state.state !== 'locked' || locked) return state;
    let work = unlocking.get(this);
    if (!work) { work = this.unlock({ password }, options).finally(() => unlocking.delete(this)); unlocking.set(this, work); }
    return work;
  });
  const store = new Keystore(vault);
  await store.unlock({ password, create: true, confirmation: password });
  active = store;
  t.after(async () => { for (const session of sessions) session.close(); await rm(directory, { recursive: true, force: true }); });
  async function control(operation: 'lock' | 'unlock') {
    locked = operation === 'lock';
    for (const session of sessions) session.lock();
  }
  const installSource = `
    import {Keystore as FixtureKeystore} from ${JSON.stringify(new URL('../keystore.js', import.meta.url).href)};
    import {keychain as fixtureKeychain} from ${JSON.stringify(new URL('../keychain.js', import.meta.url).href)};
    fixtureKeychain.get = async () => undefined;
    const fixtureOpen = FixtureKeystore.prototype.open;
    FixtureKeystore.prototype.open = function() { Object.defineProperty(this, 'directory', {value:${JSON.stringify(vault)}, configurable:true}); return fixtureOpen.call(this); };
    const fixtureUnlocking = new WeakMap();
    const fixtureStatus = FixtureKeystore.prototype.status;
    FixtureKeystore.prototype.status = async function(options) { const state = await fixtureStatus.call(this,options); if(state.state !== 'locked') return state; let work=fixtureUnlocking.get(this); if(!work){work=this.unlock({password:${JSON.stringify(password)}},options).finally(()=>fixtureUnlocking.delete(this));fixtureUnlocking.set(this,work);}return work; };
  `;
  return { directory, store, control, installSource };
}
