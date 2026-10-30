import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ComposeSpec } from './contracts.js';
import { ComposeCli } from './compose-cli.js';

// Buildx Bake reads files under its working directory and the build contexts Compose grants. The private Dockerfile
// copies are readable to a build only when Compose runs from the directory that holds them, never from the source.
test('Compose inspection and builds run from the private command directory, not the source', { skip: process.platform === 'win32' && 'Requires a POSIX shell' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-compose-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const source = join(directory, 'source');
  const seen = join(directory, 'cwd.log');
  await mkdir(bin);
  await mkdir(source);
  await writeFile(join(bin, 'docker'), `#!/bin/sh\npwd -P >> '${seen}'\necho '{}'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = [bin, path ?? '/usr/bin:/bin'].join(delimiter);
  t.after(() => { process.env.PATH = path; });

  const cli = await ComposeCli.create(directory, join(directory, 'docker.sock'));
  t.after(() => cli.close());
  const spec: ComposeSpec = { name: 'cwd', type: 'compose', cwd: source, files: ['compose.yaml'], profiles: [], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } } }], primary: { service: 'web', port: 'http' }, routes: {}, timeoutMs: 120000 };
  const model = join(cli.directory, 'compose.json');
  await cli.config(spec, [model], true, AbortSignal.timeout(10_000));
  await cli.run(spec, 'previewhost-cwd', model, ['build'], { signal: AbortSignal.timeout(10_000), redactions: [], appendLog() {}, onResource() {} });

  const commands = await realpath(cli.directory);
  assert.deepEqual((await readFile(seen, 'utf8')).trim().split('\n'), [commands, commands]);
});
