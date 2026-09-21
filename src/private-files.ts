import { constants, mkdirSync, type Stats } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import koffi from 'koffi';
import { PreviewError } from './errors.js';
import { assertWindowsPrivate, lockWindowsFile, makeWindowsPrivateDirectory } from './windows.js';

export function requireSupportedPlatform(): void {
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new PreviewError('UNSUPPORTED_PLATFORM', 'Previewhost requires macOS, Linux, or Windows on x64 or arm64.');
  }
}

export function makePrivateDirectory(path: string): void {
  requireSupportedPlatform();
  if (process.platform === 'win32') makeWindowsPrivateDirectory(path);
  else mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function isPrivate(path: string, info: Stats): boolean {
  if (process.platform === 'win32') { assertWindowsPrivate(path); return true; }
  return info.uid === process.getuid!() && (info.mode & 0o077) === 0;
}

let flock: ((fd: number, operation: number) => number) | undefined;
/** One permanent inode, nonblocking kernel lock, released only after caller cleanup. */
export async function openOwnerLock(path: string, create = true): Promise<FileHandle> {
  requireSupportedPlatform();
  const flags = constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags | (process.platform === 'darwin' ? 0x20 : 0), 0o600);
  let release: (() => void) | undefined;
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (!named.isFile() || !info.isFile() || info.nlink !== 1 || named.dev !== info.dev || named.ino !== info.ino || !isPrivate(path, info)) {
      throw new PreviewError('UNAUTHORIZED', 'The permanent ownership lock is unsafe.');
    }
    if (process.platform === 'linux') {
      flock ??= koffi.load(null).func('int flock(int, int)');
      if (flock(file.fd, 2 | 4) !== 0) { // LOCK_EX | LOCK_NB; Node opens descriptors CLOEXEC.
        const errno = koffi.errno();
        throw Object.assign(new Error(`flock failed (${errno}).`), { code: errno === 11 ? 'EAGAIN' : 'EIO' });
      }
    } else if (process.platform === 'win32') {
      release = lockWindowsFile(path);
      const close = file.close.bind(file);
      file.close = async () => { await close(); release?.(); release = undefined; };
    }
    return file;
  } catch (error) { await file.close(); throw error; }
}
