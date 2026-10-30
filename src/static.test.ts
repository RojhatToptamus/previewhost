import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStatic } from './static.js';

test('a directory swapped for a link between the path check and the open never serves a file outside the root', {
  skip: process.platform === 'win32' && 'Symlinks require privileges on Windows',
}, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-static-swap-')));
  const root = join(directory, 'site');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', 'key.txt'), 'inside');
  await mkdir(join(directory, 'private'));
  await writeFile(join(directory, 'private', 'key.txt'), 'outside secret');
  const resource = await startStatic(root, false);
  const { open, lstat } = fsPromises;
  t.after(async () => { Object.assign(fsPromises, { open, lstat }); await resource.stop(); await rm(directory, { recursive: true, force: true }); });
  const request = async () => {
    const response = await fetch(`http://127.0.0.1:${resource.target.port}/assets/key.txt`);
    return { status: response.status, body: await response.text() };
  };
  assert.deepEqual(await request(), { status: 200, body: 'inside' });

  const target = join(root, 'assets', 'key.txt');
  const swap = async () => { await rename(join(root, 'assets'), join(root, 'assets-moved')); await symlink(join(directory, 'private'), join(root, 'assets')); };
  const restore = async () => { await unlink(join(root, 'assets')); await rename(join(root, 'assets-moved'), join(root, 'assets')); };
  // Each request passes the realpath check first; the swap then lands right before the open. The link stays,
  // is removed once the open returns (as a RENAME_EXCHANGE loop can), or is removed only after the path of the
  // file itself has been checked again, which no check of the path can tell from an unchanged directory.
  for (const until of ['never', 'open', 'lstat'] as const) {
    let swapped = false;
    let restored = false;
    fsPromises.open = async function (this: unknown, file: Parameters<typeof open>[0], ...rest: unknown[]) {
      if (swapped || file !== target) return Reflect.apply(open, this, [file, ...rest]);
      swapped = true;
      await swap();
      try { return await Reflect.apply(open, this, [file, ...rest]); }
      finally { if (until === 'open') { await restore(); restored = true; } }
    } as typeof open;
    fsPromises.lstat = async function (this: unknown, file: Parameters<typeof lstat>[0], ...rest: unknown[]) {
      const result = await Reflect.apply(lstat, this, [file, ...rest]);
      if (until === 'lstat' && swapped && !restored && file === target) { await restore(); restored = true; }
      return result;
    } as typeof lstat;
    const result = await request();
    fsPromises.open = open;
    fsPromises.lstat = lstat;
    if (!restored) await restore();
    assert.ok(swapped, until);
    assert.equal(result.status, 404, until);
    assert.doesNotMatch(result.body, /outside secret/, until);
  }
  assert.deepEqual(await request(), { status: 200, body: 'inside' });
});
