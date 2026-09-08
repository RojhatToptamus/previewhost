import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { testKeychain } from './testSupport/keychain.js';

const enabled = { skip: process.platform !== 'darwin', timeout: 30_000 };
const execute = promisify(execFile);

test('hidden terminal entry, cancellation, paste overflow, and TTY misuse never echo input and restore the terminal', enabled, async () => {
  const result = await execute('/usr/bin/python3', [resolve('src/secret-input.pty.py'), process.execPath, new URL('./secret-input.js', import.meta.url).href], { timeout: 20_000 });
  assert.deepEqual(JSON.parse(result.stdout), { checks: 5, hiddenInput: true, terminalRestored: true });
  assert.equal(result.stderr, '');
});

test('CLI stdin preserves exact UTF-8 bytes in the shared store and rejects invalid bytes, value arguments, and oversize input', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const driver = join(fixture.directory, 'cli-fixture.mjs');
  await writeFile(driver, `${fixture.installSource}\nawait import(${JSON.stringify(new URL('./cli.js', import.meta.url).href)});`);
  function cli(args: string[], input = Buffer.alloc(0)): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [driver, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject); child.stdin.on('error', () => {});
      child.once('close', (code) => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
      child.stdin.end(input);
    });
  }
  const value = '\ufeff FAKE_opaque_ü\nsecond line \n';
  const saved = await cli(['secrets', 'set', 'owner/value', '--stdin'], Buffer.from(value));
  assert.equal(saved.code, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { saved: 'owner/value' });
  assert.equal(saved.stderr, '');
  assert.equal(await fixture.store.get('user', 'owner/value'), value);
  const replaced = await cli(['secrets', 'set', 'owner/value', '--stdin'], Buffer.from('FAKE_replacement'));
  assert.equal(replaced.code, 0);
  assert.equal(await fixture.store.get('user', 'owner/value'), 'FAKE_replacement');
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from('FAKE_nul\0value'), Buffer.alloc(4097, 65), Buffer.alloc(0)]) {
    const rejected = await cli(['secrets', 'set', 'invalid', '--stdin'], invalid);
    assert.equal(rejected.code, 1);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_INPUT');
    assert.equal(rejected.stdout, '');
    assert.ok(!rejected.stderr.includes('FAKE_'));
    assert.equal(await fixture.store.has('user', 'invalid'), false);
  }
  for (const args of [['secrets', 'set', 'invalid', 'FAKE_value_argument'], ['secrets', 'set', 'invalid', '--value', 'FAKE_value_argument']]) {
    const rejected = await cli(args);
    assert.equal(rejected.code, 1);
    assert.ok(!rejected.stderr.includes('FAKE_'));
  }
  const listed = await cli(['secrets', 'list']);
  assert.deepEqual(JSON.parse(listed.stdout), { ids: ['owner/value'], truncated: false });
  assert.ok(!listed.stdout.includes('FAKE_'));
  assert.equal((await cli(['secrets', 'remove', 'owner/value'])).code, 0);
  assert.equal(await fixture.store.has('user', 'owner/value'), false);
});
