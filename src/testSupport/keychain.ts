import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { Keychain } from '../keychain.js';

const execute = promisify(execFile);
const invoke = Keychain.prototype.invoke;
const helper = fileURLToPath(new URL('../native/keychain', import.meta.url));
const fixture = fileURLToPath(new URL('../native/keychain-fixture', import.meta.url));

/** Every operation still uses Security.framework, against this disposable Keychain only. */
export async function testKeychain(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-test-keychain-'));
  const path = join(directory, 'previewhost-test-items.keychain');
  async function control(operation: 'create' | 'lock' | 'unlock' | 'remove') {
    const result = await execute(fixture, [operation, path], { timeout: 10_000 });
    assert.equal(result.stdout.trim(), '0');
  }
  try { await control('create'); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  t.after(async () => { await control('unlock'); await control('remove'); await rm(directory, { recursive: true, force: true }); });
  const store = new Keychain(helper, [path]);
  t.mock.method(Keychain.prototype, 'invoke', function (request: Parameters<Keychain['invoke']>[0], options: Parameters<Keychain['invoke']>[1]) {
    return invoke.call(store, request, options);
  });
  return { directory, path, helper, control, store };
}
