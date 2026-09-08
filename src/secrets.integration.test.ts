import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { createPreviewRuntime } from './runtime.js';
import { keychain, type KeychainOptions, type SecretNamespace } from './keychain.js';
import { removeSecret, setSecret } from './secrets.js';
import { testKeychain } from './testSupport/keychain.js';
import type { PreviewSpec, PreviewStatus } from './contracts.js';

const enabled = { skip: process.platform !== 'darwin', timeout: 60_000 };
const app = `import http from 'node:http'; import fs from 'node:fs';
  fs.appendFileSync('starts', process.pid + '\\n');
  console.log(process.env.VALUE, encodeURIComponent(process.env.VALUE || ''));
  http.createServer((req,res)=>res.end(JSON.stringify({value:process.env.VALUE,again:process.env.AGAIN,
    owner:process.env.OWNER,literal:process.env.LITERAL,ambient:process.env.PREVIEWD_UNSELECTED_TEST,other:process.env.OTHER})))
    .listen(Number(process.env.PORT),process.env.HOST);`;

function body(url: string): Promise<Record<string, string>> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: target.port, path: '/', headers: { host: target.host } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.once('error', reject); res.once('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    req.once('error', reject); req.end();
  });
}
async function outcome(runtime: Awaited<ReturnType<typeof createPreviewRuntime>>, status: PreviewStatus) {
  return runtime.wait(status.name, status.candidate!.id);
}

test('selected references resolve once before effects, reach only declared recipients, and reread after edits', enabled, async (t) => {
  const fixture = await testKeychain(t);
  await writeFile(join(fixture.directory, 'app.mjs'), app);
  await setSecret('shared', 'FAKE_shared ü\nnext'); await setSecret('other', 'FAKE_other');
  const originalGet = keychain.get.bind(keychain);
  const reads = t.mock.method(keychain, 'get', originalGet);
  const oldAmbient = process.env.PREVIEWD_UNSELECTED_TEST;
  process.env.PREVIEWD_UNSELECTED_TEST = 'FAKE_ambient';
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['shared', 'other'],
    inputs: { SOURCE: 'FAKE_owner' }, authorize: () => true });
  const command = { type: 'command' as const, cwd: fixture.directory, command: [process.execPath, 'app.mjs'] };
  const spec: PreviewSpec = { name: 'scope', type: 'environment', primary: 'web', services: {
    web: { ...command, env: { VALUE: { secret: 'shared' }, AGAIN: { secret: 'shared' }, OWNER: { fromEnv: 'SOURCE' }, LITERAL: 'ordinary' } },
    other: { ...command, env: { OTHER: { secret: 'other' } } },
  } };
  try {
    const description = await runtime.inspect(spec);
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(description.secrets?.find((item) => item.id === 'shared')?.bindings.length, 2);
    assert.ok(!JSON.stringify(description).includes('FAKE_'));
    const ready = await outcome(runtime, await runtime.start(spec));
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.deepEqual(reads.mock.calls.map((call) => call.arguments[1]).sort(), ['other', 'shared']);
    assert.deepEqual(await body(ready.url!), { value: 'FAKE_shared ü\nnext', again: 'FAKE_shared ü\nnext', owner: 'FAKE_owner', literal: 'ordinary' });
    assert.deepEqual(await body(ready.services!.other.browserUrl!), { other: 'FAKE_other' });
    const publicState = JSON.stringify([await runtime.get('scope'), await runtime.logs('scope')]);
    assert.ok(!publicState.includes('FAKE_'));
    await setSecret('shared', 'FAKE_rotated');
    assert.equal((await body(ready.url!)).value, 'FAKE_shared ü\nnext');
    const replacement = await outcome(runtime, await runtime.replace('scope', spec));
    assert.equal(replacement.state, 'ready');
    assert.equal((await body(ready.url!)).value, 'FAKE_rotated');
    await removeSecret('shared');
    const beforeFailure = await readFile(join(fixture.directory, 'starts'), 'utf8');
    const missing = await outcome(runtime, await runtime.replace('scope', spec));
    assert.equal(missing.error?.code, 'SECRET_REQUIRED');
    assert.deepEqual(missing.error?.requirements?.map((item) => item.id), ['shared']);
    assert.equal(await readFile(join(fixture.directory, 'starts'), 'utf8'), beforeFailure);
    assert.equal((await body(ready.url!)).value, 'FAKE_rotated');
    await setSecret('shared', 'FAKE_restored'); await fixture.control('lock');
    const locked = await outcome(runtime, await runtime.replace('scope', spec));
    assert.equal(locked.error?.code, 'SECRET_STORE_UNAVAILABLE');
    assert.equal(await readFile(join(fixture.directory, 'starts'), 'utf8'), beforeFailure);
    await fixture.control('unlock');
    const standalone = await outcome(runtime, await runtime.start({ name: 'standalone', ...command, env: { VALUE: { secret: 'shared' } } }));
    assert.equal(standalone.state, 'ready');
    assert.equal((await body(standalone.url!)).value, 'FAKE_restored');
  } finally {
    await runtime.close();
    if (oldAmbient === undefined) delete process.env.PREVIEWD_UNSELECTED_TEST; else process.env.PREVIEWD_UNSELECTED_TEST = oldAmbient;
  }
});

test('unselected and canceled secret resolution create no listener or command', enabled, async (t) => {
  const fixture = await testKeychain(t);
  await writeFile(join(fixture.directory, 'app.mjs'), app);
  await setSecret('selected', 'FAKE_value');
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['selected'], authorize: () => true });
  const spec: PreviewSpec = { name: 'denied', type: 'command', cwd: fixture.directory, command: [process.execPath, 'app.mjs'], env: { VALUE: { secret: 'not-selected' } } };
  try {
    const reads = t.mock.method(keychain, 'get', keychain.get.bind(keychain));
    const denied = await outcome(runtime, await runtime.start(spec));
    assert.equal(denied.error?.code, 'SECRET_DENIED');
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(denied.url, undefined);
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    reads.mock.restore();
    t.mock.method(keychain, 'get', async (_namespace: SecretNamespace, _id: string, options: KeychainOptions = {}) => {
      entered();
      return new Promise<string>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const pending = await runtime.start({ ...spec, name: 'canceled', env: { VALUE: { secret: 'selected' } } });
    await reading;
    await runtime.cancel('canceled', pending.candidate!.id);
    assert.equal((await runtime.get('canceled')).latest?.state, 'canceled');
    assert.equal((await runtime.get('canceled')).url, undefined);
    await assert.rejects(readFile(join(fixture.directory, 'starts')), { code: 'ENOENT' });
  } finally { await runtime.close(); }
});

test('expanded inputs and external secret URLs are validated before listeners, commands, or managed data', enabled, async (t) => {
  const fixture = await testKeychain(t);
  await writeFile(join(fixture.directory, 'app.mjs'), app);
  await setSecret('large', '界'.repeat(1365));
  await setSecret('invalid-url', 'FAKE_not_a_database_url');
  const dataDirectory = join(fixture.directory, 'retained');
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], dataDirectory, dockerSocket: join(fixture.directory, 'absent.sock'),
    secretIds: ['large', 'invalid-url'], inputs: { LARGE: '界'.repeat(1365) }, authorize: () => true });
  try {
    const before = await readdir(dataDirectory);
    const variants = [
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`VALUE_${i}`, { secret: 'large' }])),
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`VALUE_${i}`, { fromEnv: 'LARGE' }])),
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`VALUE_${i}`, '界'.repeat(4096)])),
    ];
    for (const [i, env] of variants.entries()) {
      const spec: PreviewSpec = { name: `expanded-${i}`, type: 'environment', primary: 'web', services: {
        web: { type: 'command', cwd: fixture.directory, command: [process.execPath, 'app.mjs'], env },
        database: { type: 'postgres' },
      } };
      const result = await outcome(runtime, await runtime.start(spec));
      assert.equal(result.error?.code, 'INVALID_INPUT');
      assert.match(result.error!.message, /64 KiB/);
      assert.equal(result.url, undefined);
    }
    const invalid = await outcome(runtime, await runtime.start({ name: 'invalid-dsn', type: 'environment', primary: 'web', services: {
      web: { type: 'command', cwd: fixture.directory, command: [process.execPath, 'app.mjs'] },
      external: { type: 'external-postgres', url: { secret: 'invalid-url' } },
      database: { type: 'postgres' },
    } }));
    assert.equal(invalid.error?.code, 'INVALID_INPUT');
    assert.ok(!JSON.stringify(invalid).includes('FAKE_'));
    assert.equal(invalid.url, undefined);
    await assert.rejects(readFile(join(fixture.directory, 'starts')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(dataDirectory), before);
  } finally { await runtime.close(); }
});
