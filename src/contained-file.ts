import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from './spec.js';

/**
 * Opens `file`, an absolute path inside `root` without links, so that no link on its path can redirect the open.
 * `O_NOFOLLOW` covers only the last component. Every directory from the filesystem root to the file's parent
 * must be a directory, not a link, with the same identity before and after the open, and the path must still
 * name the opened file afterwards. A directory swapped in between, even back again, fails closed.
 */
export async function openContained(root: string, file: string): Promise<fs.FileHandle> {
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
    const entry = await fs.lstat(file, { bigint: true });
    if (await identities() !== before || entry.dev !== opened.dev || entry.ino !== opened.ino) {
      throw new Error('The file changed while it was opened.');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
