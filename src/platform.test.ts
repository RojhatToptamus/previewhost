import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { makePrivateDirectory, openOwnerLock } from './private-files.js';
import { commandEnvironment } from './native.js';

// These tests exercise kernel locks; no lock or platform mocks.
test('kernel lock excludes independent handles and processes, allows owner reads, and releases after crash', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'previewhost-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  makePrivateDirectory(directory);
  const path = join(directory, '.lock');
  const held = await openOwnerLock(path);
  try {
    await held.writeFile('owner-identity\n');
    await held.sync();
    assert.equal(await readFile(path, 'utf8'), 'owner-identity\n');
    await assert.rejects(openOwnerLock(path), { code: 'EAGAIN' });
  } finally { await held.close(); }
  const script = join(root, 'owner.mjs');
  await writeFile(script, `import { openOwnerLock } from ${JSON.stringify(new URL('./private-files.js', import.meta.url).href)};
const lock = await openOwnerLock(process.argv[2]); process.send('locked'); setInterval(() => {}, 1000);`);
  const child = fork(script, [path], { execArgv: [], silent: true });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    await assert.rejects(openOwnerLock(path), { code: 'EAGAIN' });
  } finally { child.kill('SIGKILL'); await exited; }
  const reacquired = await openOwnerLock(path);
  try { assert.equal(await reacquired.readFile('utf8'), 'owner-identity\n'); }
  finally { await reacquired.close(); }
});

if (process.platform === 'win32') test('Windows environment merging is case-insensitive and refuses ambiguous input names', () => {
  assert.equal(commandEnvironment({ Path: 'explicit-path' }, undefined, '').PATH, 'explicit-path');
  assert.throws(() => commandEnvironment({ PATH: 'one', Path: 'two' }, undefined, ''), { code: 'INVALID_INPUT' });
  assert.equal(commandEnvironment({}, 1234, 'http://example.test').PORT, '1234');
});

if (process.platform === 'win32') test('Windows private creation, inherited ACLs, broad token access and junctions', async t => {
  const { execFileSync } = await import('node:child_process');
  const { symlink } = await import('node:fs/promises');
  const { readToken } = await import('./client.js');
  const root = await mkdtemp(join(tmpdir(), 'previewhost-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  makePrivateDirectory(directory);
  const token = join(directory, 'token');
  await writeFile(token, 'a'.repeat(64));
  assert.equal(await readToken(token), 'a'.repeat(64));
  execFileSync('icacls.exe', [token, '/grant', '*S-1-1-0:(R)']);
  await assert.rejects(readToken(token), { code: 'UNAUTHORIZED' });
  const junction = join(root, 'junction');
  await symlink(directory, junction, 'junction');
  assert.throws(() => makePrivateDirectory(junction), { code: 'UNAUTHORIZED' });
});

if (process.platform === 'win32') test('Windows connection reads tolerate clean shutdown unlinking after stat', async t => {
  const fs = (await import('node:fs/promises')).default;
  const { basename } = await import('node:path');
  const { syncBuiltinESMExports } = await import('node:module');
  const { projectOwnerDirectory, readProjectRecord, writeProjectRecord } = await import('./project.js');
  const root = await mkdtemp(join(tmpdir(), 'previewhost-record-unlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, basename(projectOwnerDirectory(root)));
  makePrivateDirectory(directory);
  const record = { projectDirectory: root, dataDirectory: join(root, 'data') };
  await writeProjectRecord(directory, record);
  assert.deepEqual(await readProjectRecord(directory), record);
  const path = join(directory, 'connection.json');
  const open = fs.open;
  let unlinked = false;
  const replacement = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (args[0] === path) {
      const stat = file.stat.bind(file);
      t.mock.method(file, 'stat', async () => {
        const info = await stat();
        assert.equal(info.nlink, 1);
        await fs.unlink(path);
        unlinked = true;
        return info;
      });
    }
    return file;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await readProjectRecord(directory), undefined);
    assert.equal(unlinked, true, 'The record must be removed after the open handle was statted.');
  } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
});

if (process.platform === 'win32') test('Windows rejects non-inheritable private directories before writing a token and permits split inheritance', async t => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir, lstat } = await import('node:fs/promises');
  const { readToken } = await import('./client.js');
  const { startDaemon } = await import('./daemon.js');
  const { createPreviewRuntime } = await import('./runtime.js');
  const root = await mkdtemp(join(tmpdir(), 'previewhost-inheritance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function directory(name: string, inherited: boolean) {
    const path = join(root, name);
    await mkdir(path);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      if ($env:PREVIEWHOST_ACL_INHERITANCE -eq 'yes') {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify', 'ObjectInherit', 'InheritOnly', 'Allow'))
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify', 'ContainerInherit', 'None', 'Allow'))
      } else {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'None', 'None', 'Allow'))
      }
      [System.IO.Directory]::SetAccessControl($env:PREVIEWHOST_ACL_DIRECTORY, $acl)
    `], { env: { ...process.env, PREVIEWHOST_ACL_DIRECTORY: path, PREVIEWHOST_ACL_INHERITANCE: inherited ? 'yes' : 'no' }, timeout: 10_000 });
    return path;
  }
  const unsafe = await directory('non-inheritable', false);
  const token = join(unsafe, 'token');
  assert.throws(() => makePrivateDirectory(unsafe), { code: 'UNAUTHORIZED' });
  await assert.rejects(readToken(token), { code: 'UNAUTHORIZED' });
  const runtime = await createPreviewRuntime({ allowedRoots: [root] });
  t.after(() => runtime.close());
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  t.after(async () => { await daemon?.close(); });
  await assert.rejects(async () => { daemon = await startDaemon({ runtime, tokenFile: token, port: 0 }); }, { code: 'UNAUTHORIZED' });
  await assert.rejects(lstat(token), { code: 'ENOENT' });
  const safe = await directory('split-inheritance', true);
  assert.doesNotThrow(() => makePrivateDirectory(safe));
  await writeFile(join(safe, 'token'), 'a'.repeat(64));
  assert.equal(await readToken(join(safe, 'token')), 'a'.repeat(64));
});

if (process.platform === 'win32') test('Windows process death during record replacement leaves a complete published record', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'previewhost-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private'); makePrivateDirectory(directory);
  const record = join(directory, 'record.json');
  const script = join(root, 'writer.mjs');
  await writeFile(script, `import { open } from 'node:fs/promises';
import { publishWindowsFile } from ${JSON.stringify(new URL('./windows.js', import.meta.url).href)};
const record = process.argv[2];
for (let sequence = 0; ; sequence++) {
  const file = await open(record + '.tmp', 'w');
  await file.writeFile(JSON.stringify({ sequence, payload: 'complete'.repeat(8192) }));
  await file.sync(); await file.close();
  publishWindowsFile(record + '.tmp', record);
  if (sequence === 0) process.send('published');
}`);
  const child = fork(script, [record], { execArgv: [], silent: true });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { child.kill('SIGKILL'); await exited; }
  const value = JSON.parse(await readFile(record, 'utf8'));
  assert.ok(Number.isInteger(value.sequence) && value.sequence >= 0);
  assert.equal(value.payload, 'complete'.repeat(8192));
});
