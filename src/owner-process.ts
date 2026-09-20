import { unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { startDaemon } from './daemon.js';
import { failure, PreviewError } from './errors.js';
import { lockProject, readProjectRecord, writeProjectRecord, ownerInfoSchema, projectOwnerDirectory, type ProjectLaunch } from './project.js';
import { createPreviewRuntime, needsExecution } from './runtime.js';

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
    try { lock = await lockProject(directory); }
    catch (error) {
      if (error instanceof PreviewError && error.code === 'BUSY') {
        if (process.connected) process.send?.({ busy: true }, () => {});
        return;
      }
      throw error;
    }
    const previous = await readProjectRecord(directory);
    if (previous?.endpoint) throw new PreviewError('CLEANUP_INCOMPLETE', `A previous owner left ${connection}. Verify application cleanup before removing that connection file and retrying.`);
    if (previous && previous.dataDirectory !== info.dataDirectory) throw new PreviewError('INVALID_INPUT', 'The retained data directory changed during owner startup. Retry with its existing directory.');
    runtime = await createPreviewRuntime({ allowedRoots: info.allowedRoots, inputs, secretIds: info.secretIds,
      dataDirectory: info.dataDirectory, dockerSocket: info.dockerSocket, authorize: request => info.allowExec || request.operation === 'allow-sources' ||
        ((request.operation === 'start' || request.operation === 'replace') && !needsExecution(request.spec)),
    });
    daemon = await startDaemon({ runtime, tokenFile: join(directory, 'token'), port: 0, owner: info });
    const stop = () => { void daemon!.close().catch(() => {}); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const identity = { projectDirectory: info.projectDirectory, dataDirectory: info.dataDirectory, dockerSocket: info.dockerSocket };
      await writeProjectRecord(directory, { ...identity, endpoint: daemon.endpoint, pid: info.pid }); published = true;
      if (process.connected) process.send?.({ ready: true }, () => {});
      // The launcher's disconnect deliberately has no shutdown handler.
      await daemon.closed;
      if ((await runtime.list()).some(preview => preview.data)) await writeProjectRecord(directory, identity);
      else await unlink(connection);
      published = false;
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
