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
  const open = fsPromises.open;
  t.after(async () => { fsPromises.open = open; await resource.stop(); await rm(directory, { recursive: true, force: true }); });
  const request = async () => {
    const response = await fetch(`http://127.0.0.1:${resource.target.port}/assets/key.txt`);
    return { status: response.status, body: await response.text() };
  };
  assert.deepEqual(await request(), { status: 200, body: 'inside' });

  // Each request passes the realpath check first; the swap then lands right before the open.
  // The second variant restores the directory once the open returns, as a RENAME_EXCHANGE loop can.
  for (const restore of [false, true]) {
    let swapped = false;
    fsPromises.open = async function (this: unknown, file: Parameters<typeof open>[0], ...rest: unknown[]) {
      if (swapped || file !== join(root, 'assets', 'key.txt')) return Reflect.apply(open, this, [file, ...rest]);
      swapped = true;
      await rename(join(root, 'assets'), join(root, 'assets-moved'));
      await symlink(join(directory, 'private'), join(root, 'assets'));
      try { return await Reflect.apply(open, this, [file, ...rest]); }
      finally { if (restore) { await unlink(join(root, 'assets')); await rename(join(root, 'assets-moved'), join(root, 'assets')); } }
    } as typeof open;
    const result = await request();
    fsPromises.open = open;
    assert.ok(swapped, `restore: ${restore}`);
    assert.equal(result.status, 404, `restore: ${restore}`);
    assert.doesNotMatch(result.body, /outside secret/, `restore: ${restore}`);
    if (!restore) { await unlink(join(root, 'assets')); await rename(join(root, 'assets-moved'), join(root, 'assets')); }
  }
  assert.deepEqual(await request(), { status: 200, body: 'inside' });
});
