import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from './spec.js';

/**
 * Opens the regular file `file`, an absolute path inside the real directory `root`, and proves where the opened
 * descriptor itself lives: no check of the path can, because a directory on it can be swapped for a link before
 * the open and restored before the check. On Linux the descriptor's path comes from `/proc/self/fd`, on macOS
 * from `fcntl(F_GETPATH)`; either must lie inside `root` and satisfy `allowed`, and an unavailable path fails
 * closed. The open never follows a final link and never blocks on a FIFO.
 * Windows has neither source and keeps only the identity checks of every directory on the path.
 */
export async function openContained(root: string, file: string, allowed: (real: string) => boolean = () => true): Promise<fs.FileHandle> {
  if (file === root || !isWithin(root, file)) throw new Error('The file is outside its directory.');
  const parents: string[] = [];
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    parents.unshift(directory);
    if (path.dirname(directory) === directory) break;
  }
  const identities = async () => (await Promise.all(parents.map(async directory => {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory()) throw new Error('The path to the file passes through a symlink.');
    return `${stat.dev}:${stat.ino}`;
  }))).join();
  const before = await identities();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error('The file is not a regular file.');
    const real = await descriptorPath(handle.fd);
    if (real !== undefined && (!isWithin(root, real) || real === root || !allowed(real))) throw new Error('The opened file is outside its directory.');
    const entry = await fs.lstat(file, { bigint: true });
    if (await identities() !== before || entry.dev !== opened.dev || entry.ino !== opened.ino) {
      throw new Error('The file changed while it was opened.');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

let getPath: ((fd: number, buffer: Buffer) => number) | undefined;

/** The path the kernel holds for an open descriptor. `undefined` only on Windows. */
async function descriptorPath(fd: number): Promise<string | undefined> {
  if (process.platform === 'linux') return fs.readlink(`/proc/self/fd/${fd}`);
  if (process.platform !== 'darwin') return undefined;
  if (!getPath) {
    // Loaded only on macOS, as windows.ts is only on Windows.
    const { default: koffi } = await import('koffi');
    const fcntl = koffi.load('/usr/lib/libSystem.B.dylib').func('int fcntl(int, int, ...)');
    getPath = (descriptor, buffer) => fcntl(descriptor, 50 /* F_GETPATH */, 'uint8_t *', buffer) as number;
  }
  const buffer = Buffer.alloc(1024); // MAXPATHLEN
  const end = getPath(fd, buffer) === 0 ? buffer.indexOf(0) : -1;
  if (end < 1) throw new Error('The path of the opened file is unavailable.');
  return buffer.subarray(0, end).toString('utf8');
}
