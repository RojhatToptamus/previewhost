import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComposeSpec } from './contracts.js';
import type { ComposeCli } from './compose-cli.js';
import { prepareCompose } from './compose-inspection.js';

// Each refusal happens while host files are read, before any Docker command; a CLI call would fail differently.
async function refused(t: test.TestContext, files: Record<string, string>, prepare?: (source: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const commands = join(directory, 'commands');
  await mkdir(source);
  await mkdir(commands);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(source, name, '..'), { recursive: true });
    await writeFile(join(source, name), contents);
  }
  await prepare?.(source, directory);
  const spec: ComposeSpec = { name: 'files', type: 'compose', cwd: source, files: ['compose.yaml'], profiles: [], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } } }], primary: { service: 'web', port: 'http' }, routes: {}, timeoutMs: 120000 };
  return prepareCompose(spec, { directory: commands } as unknown as ComposeCli, AbortSignal.timeout(10_000));
}

const service = (lines: string) => `services:\n  web:\n    image: busybox:1.37\n    expose: [8080]\n${lines}`;

test('Compose host files with another hard link are refused', async t => {
  await assert.rejects(refused(t, { 'compose.yaml': service('') }, source => link(join(source, 'compose.yaml'), join(source, 'alias.yaml'))), /hard link/);
  await assert.rejects(refused(t, { 'compose.yaml': service('    env_file: app.env\n'), 'app.env': 'A=1\n' },
    source => link(join(source, 'app.env'), join(source, 'alias.env'))), /hard link/);
});

test('Compose host files reached through a symlinked directory are refused', { skip: process.platform === 'win32' && 'Symlinks require privileges on Windows' }, async t => {
  await assert.rejects(refused(t, { 'compose.yaml': service('    env_file: config/app.env\n'), 'real/app.env': 'A=1\n' },
    source => symlink(join(source, 'real'), join(source, 'config'))), /symlink/);
  await assert.rejects(refused(t, { 'compose.yaml': service('    secrets: [token]\nsecrets:\n  token:\n    file: keys/token\n'), 'real/token': 'secret' },
    (source, directory) => symlink(directory, join(source, 'keys'))), /symlink/);
});

test('Compose files over 1 MiB and env or secret files over 64 KiB are refused', async t => {
  await assert.rejects(refused(t, { 'compose.yaml': service(`    command: ["${'x'.repeat(1024 * 1024)}"]\n`) }), /bounded/);
  await assert.rejects(refused(t, { 'compose.yaml': service('    env_file: app.env\n'), 'app.env': `A=${'x'.repeat(64 * 1024)}\n` }), /bounded/);
  await assert.rejects(refused(t, { 'compose.yaml': service('    secrets: [token]\nsecrets:\n  token:\n    file: token\n'), 'token': 'x'.repeat(64 * 1024 + 1) }), /bounded/);
});

test('remote and home build contexts are refused even when a directory has that literal name', async t => {
  // Windows file names cannot contain ':', so only the home form gets a literal directory there.
  for (const context of process.platform === 'win32' ? ['~cache'] : ['~cache', 'git@github.com:x/y.git', 'https://github.com/x/y.git#main']) {
    const directory = context.replace('https://', 'https:/');
    await assert.rejects(refused(t, { 'compose.yaml': service(`    build: { context: '${context}' }\n`), [`${directory}/Dockerfile`]: 'FROM busybox:1.37\n' }),
      /must be a local directory/, context);
  }
});
