import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { checkTokenDirectory } from './client.js';
import { startDaemon } from './daemon.js';
import { failure, PreviewError } from './errors.js';
import { ownerInfoSchema, projectOwnerDirectory, type ProjectLaunch } from './project.js';
import { createPreviewRuntime } from './runtime.js';

// One detached owner owns this permanent kernel lock until all runtime cleanup finishes.
async function run(launch: ProjectLaunch): Promise<void> {
  const info = ownerInfoSchema.parse({ ...launch.info, pid: process.pid });
  const inputs = z.record(z.string(), z.string()).parse(launch.inputs);
  const directory = projectOwnerDirectory(info.projectDirectory);
  const connection = join(directory, 'connection.json');
  const temporary = join(directory, 'connection.tmp');
  let lock: FileHandle | undefined;
  let runtime: Awaited<ReturnType<typeof createPreviewRuntime>> | undefined;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let published = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkTokenDirectory(join(directory, 'token'));
    try {
      // Darwin O_EXLOCK, as used by the existing data owner. Never unlink this lock inode.
      lock = await open(join(directory, '.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
        if (process.connected) process.send?.({ busy: true }, () => {});
        return;
      }
      throw error;
    }
    const stat = await lock.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new PreviewError('UNAUTHORIZED', 'The project lock is unsafe.');
    const previous = await lstat(connection).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (previous) throw new PreviewError('CLEANUP_INCOMPLETE', `A previous owner left ${connection}. Verify application cleanup before removing that connection file and retrying.`);
    runtime = await createPreviewRuntime({ allowedRoots: info.allowedRoots, inputs, secretIds: info.secretIds,
      dataDirectory: info.dataDirectory, dockerSocket: info.dockerSocket, ...(info.allowExec ? { authorize: () => true } : {}),
    });
    daemon = await startDaemon({ runtime, tokenFile: join(directory, 'token'), port: 0, owner: info });
    const stop = () => { void daemon!.close().catch(() => {}); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      // A dead pre-publication owner cannot have received application requests.
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ endpoint: daemon.endpoint, pid: info.pid, projectDirectory: info.projectDirectory })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, connection); published = true;
      if (process.connected) process.send?.({ ready: true }, () => {});
      // The launcher's disconnect deliberately has no shutdown handler.
      await daemon.closed;
      await unlink(connection); published = false;
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  } catch (error) {
    if (process.connected) process.send?.({ error: failure(error) }, () => {});
    process.exitCode = 1;
  } finally {
    // Failed cleanup deliberately retains the connection record for explicit recovery.
    try { if (daemon) await daemon.close(); else await runtime?.close(); }
    catch { process.exitCode = 1; }
    if (lock && !published) await unlink(temporary).catch(() => {});
    await lock?.close();
    if (process.connected) process.disconnect();
  }
}

process.once('message', (launch: ProjectLaunch) => { void run(launch); });
