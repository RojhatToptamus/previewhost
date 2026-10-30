import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContained } from './contained-file.js';

test('a descriptor path that is not absolute, or is unavailable, refuses the open', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-contained-')));
  const file = join(root, 'key.txt');
  await writeFile(file, 'inside');
  const cwd = process.cwd();
  t.after(async () => { process.chdir(cwd); await rm(root, { recursive: true, force: true }); });
  await (await openContained(root, file)).close();
  // Linux can report `(unreachable)/key.txt`; resolved against this working directory it would look inside the root.
  process.chdir(root);
  await assert.rejects(openContained(root, file, undefined, () => Promise.resolve('(unreachable)/key.txt')), /outside its directory/);
  // Without /proc, as in a minimal chroot, the path is unavailable and the open fails closed.
  await assert.rejects(openContained(root, file, undefined, () => Promise.reject(Object.assign(new Error('no /proc'), { code: 'ENOENT' }))), /no \/proc/);
});
