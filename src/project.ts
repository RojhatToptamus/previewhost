import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { checkTokenDirectory, connectPreviewDaemon, type ClientOptions } from './client.js';
import { limits, secretIdSchema, type Failure, type DeleteDataOptions, type PreviewStatus } from './contracts.js';
import { PreviewError, failure } from './errors.js';
import { canonicalDirectory, isWithin } from './spec.js';
import { createDataOwner, readRetainedData } from './data.js';

export interface ProjectOptions extends ClientOptions {
  projectDirectory?: string;
  allowedRoots?: string[];
  allowExec?: boolean;
  inputKeys?: string[];
  secretIds?: string[];
  dataDirectory?: string;
  dockerSocket?: string;
}

const directorySchema = z.string().min(1).max(4096);
export const ownerInfoSchema = z.strictObject({
  projectDirectory: directorySchema, pid: z.number().int().positive(),
  allowedRoots: z.array(directorySchema).min(1).max(32), allowExec: z.boolean(),
  inputKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(128),
  secretIds: z.array(secretIdSchema).max(limits.secrets),
  dataDirectory: directorySchema.optional(), dockerSocket: directorySchema.optional(),
});
export type ProjectOwnerInfo = z.output<typeof ownerInfoSchema>;
export interface ProjectLaunch { info: ProjectOwnerInfo; inputs: Record<string, string> }

/** A worktree has its own root; a non-Git directory uses the caller's cwd. */
export async function projectDirectory(explicit?: string): Promise<string> {
  if (explicit) return canonicalDirectory(resolve(explicit));
  let directory = process.cwd();
  try {
    const result = await promisify(execFile)('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeout: 2000, maxBuffer: 8192 });
    directory = result.stdout.replace(/\r?\n$/, '');
  } catch { /* Git is optional for a non-repository project. */ }
  return canonicalDirectory(directory);
}

/** MCP connections can serve several chats. Select each call within owner-approved roots. */
export async function selectMcpProject(requested: string | undefined, options: ProjectOptions): Promise<ProjectOptions> {
  const base = await projectDirectory(options.projectDirectory);
  if (requested === undefined) return { ...options, projectDirectory: base };
  const project = await canonicalDirectory(requested);
  const roots = await Promise.all((options.allowedRoots ?? [base]).map(root => canonicalDirectory(resolve(root))));
  let permitted = roots.some(root => isWithin(root, project));
  if (!permitted) {
    // A registered linked checkout belongs to the authorized repository even outside its directory.
    for (const root of roots) {
      try {
        const { stdout } = await promisify(execFile)('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], { timeout: 2000, maxBuffer: 65_536 });
        const paths = stdout.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
        const checkouts = await Promise.all(paths.map(path => canonicalDirectory(path).catch(() => undefined)));
        if (checkouts.includes(project)) {
          permitted = true;
          break;
        }
      } catch { /* Non-Git or inaccessible roots cannot authorize another checkout. */ }
    }
  }
  if (!permitted) throw new PreviewError('SOURCE_DENIED', 'The project must be within a configured root or be a registered Git worktree of that repository. Register the repository itself with --root, not its parent folder, to include external worktrees. Keep this chat’s actual source path; do not copy or relocate it to bypass this denial.');
  return { ...options, projectDirectory: project, allowedRoots: options.allowedRoots ? [...new Set([project, ...roots])] : [project] };
}

export function projectOwnerDirectory(project: string): string {
  // Fixed-length filesystem address for an arbitrary absolute path, not a permission/configuration hash.
  return join(homedir(), '.local', 'share', 'previewd', 'projects', createHash('sha256').update(project).digest('hex'));
}

const projectRecordSchema = z.strictObject({
  projectDirectory: directorySchema.refine(isAbsolute),
  dataDirectory: directorySchema.refine(isAbsolute).optional(), dockerSocket: directorySchema.refine(isAbsolute).optional(),
  endpoint: z.string().optional(), pid: z.number().int().positive().optional(),
}).refine(record => (record.endpoint !== undefined) === (record.pid !== undefined) && (record.endpoint !== undefined || record.dataDirectory !== undefined));
export type ProjectRecord = z.output<typeof projectRecordSchema>;

/** Resolve existing management records even when source has been removed. This grants no source access. */
export async function managementProject(explicit?: string): Promise<string> {
  try { return await projectDirectory(explicit); }
  catch (error) {
    if (!explicit) throw error;
    const root = resolve(explicit);
    const record = await readProjectRecord(projectOwnerDirectory(root));
    if (record?.projectDirectory !== root) throw error;
    return root;
  }
}

/** The same permanent lock serializes owner startup and offline management. Never unlink it. */
export async function lockProject(directory: string): Promise<FileHandle> {
  if (process.platform !== 'darwin') throw new PreviewError('UNSUPPORTED_PLATFORM', 'Automatic project management currently requires macOS.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkTokenDirectory(join(directory, 'token'));
  let lock: FileHandle | undefined;
  try {
    lock = await open(join(directory, '.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20, 0o600);
    const stat = await lock.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new PreviewError('UNAUTHORIZED', 'The project lock is unsafe.');
    return lock;
  } catch (error) {
    await lock?.close();
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') throw new PreviewError('BUSY', 'This project has a running owner or another operation in progress.');
    throw error;
  }
}

/** Called under the project lock. Connection removal remains reserved for verified clean shutdown. */
export async function writeProjectRecord(directory: string, record: ProjectRecord): Promise<void> {
  const temporary = join(directory, 'connection.tmp');
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(projectRecordSchema.parse(record))); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(directory, 'connection.json'));
}

/** Discover records only; reading them never launches an owner or grants authority. */
export async function discoverProjectOwners(directory = join(homedir(), '.local', 'share', 'previewd', 'projects')) {
  const owners: Array<{ id: string; connection?: NonNullable<Awaited<ReturnType<typeof readConnection>>>; retained?: ProjectRecord; tokenFile: string; error?: Failure }> = [];
  const stat = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (!stat) return owners;
  await checkTokenDirectory(join(directory, 'token'));
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const ownerDirectory = join(directory, entry.name);
    const tokenFile = join(ownerDirectory, 'token');
    try {
      const connection = await readProjectRecord(ownerDirectory);
      if (!connection) continue;
      owners.push({ id: entry.name, ...(connection.endpoint ? { connection: { ...connection, endpoint: connection.endpoint, pid: connection.pid! } } : { retained: connection }), tokenFile });
    } catch (error) { owners.push({ id: entry.name, tokenFile, error: failure(error) }); }
  }
  return owners.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readProjectRecord(directory: string): Promise<ProjectRecord | undefined> {
  let file;
  try {
    await checkTokenDirectory(join(directory, 'token'));
    file = await open(join(directory, 'connection.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (info.nlink === 0) return undefined; // Clean shutdown can unlink an already-open record.
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.size > 16_384) throw new Error();
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error();
    const record = projectRecordSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    if (createHash('sha256').update(record.projectDirectory).digest('hex') !== basename(directory)) throw new Error();
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PreviewError('UNAUTHORIZED', 'The project connection file or its directory is unsafe or invalid.');
  } finally { await file?.close(); }
}

async function readConnection(directory: string) {
  const record = await readProjectRecord(directory);
  return record?.endpoint ? { ...record, endpoint: record.endpoint, pid: record.pid! } : undefined;
}

/** Only cleanly shut-down records can be managed offline. A dead connection never qualifies. */
async function manageOfflineProject<T>(directory: string, operation: (record: ProjectRecord) => Promise<T>): Promise<T> {
  const lock = await lockProject(directory);
  try {
    const record = await readProjectRecord(directory);
    if (!record || record.endpoint) throw new PreviewError('STALE_ATTEMPT', 'The project connection changed. Refresh before continuing.');
    return await operation(record);
  } finally { await lock.close(); }
}

export async function offlinePreviews(record: ProjectRecord): Promise<PreviewStatus[]> {
  if (!record.dataDirectory) return [];
  return (await readRetainedData(record.dataDirectory)).map(({ name, data }) => ({ name, busy: false, data }));
}

export async function deleteOfflineData(directory: string, name: string, options: DeleteDataOptions, signal?: AbortSignal) {
  return manageOfflineProject(directory, async record => {
    const previews = await offlinePreviews(record);
    const data = previews.find(p => p.name === name)?.data;
    if (!data) throw new PreviewError('NOT_FOUND', 'This preview has no retained managed data.');
    if (options.expected && (options.expected.attemptId !== null || !isDeepStrictEqual(data.resources, options.expected.resources))) {
      throw new PreviewError('STALE_ATTEMPT', 'The managed databases changed. Review them before deleting data.');
    }
    if (data.cleanup && data.cleanup.operation !== 'remove-credential') throw new PreviewError('CLEANUP_INCOMPLETE', data.cleanup.message);
    if (signal?.aborted) throw new PreviewError('CLOSED', 'Data deletion was canceled before it began.');
    const owner = await createDataOwner({ directory: record.dataDirectory!, dockerSocket: record.dockerSocket });
    try { await owner.deleteData(name); }
    finally { await owner.close(); }
    return { name, busy: false };
  });
}

export async function removeOfflineProject(directory: string) {
  await manageOfflineProject(directory, async record => {
    if ((await offlinePreviews(record)).length) throw new PreviewError('BUSY', 'Delete the retained managed data before removing this project.');
    await unlink(join(directory, 'connection.json'));
  });
}

async function launchOptions(options: ProjectOptions, project: string): Promise<ProjectLaunch> {
  const inputKeys = [...new Set(options.inputKeys ?? [])].sort();
  const retained = await readProjectRecord(projectOwnerDirectory(project));
  if (retained && !retained.endpoint && options.dataDirectory && resolve(options.dataDirectory) !== retained.dataDirectory) {
    throw new PreviewError('INVALID_INPUT', 'This project still has a retained data directory. Delete its data and remove the entry before selecting a different directory.');
  }
  const dataDirectory = resolve(options.dataDirectory ?? retained?.dataDirectory ?? join(projectOwnerDirectory(project), 'data'));
  const dockerSocket = options.dockerSocket ?? retained?.dockerSocket;
  const info = { projectDirectory: project, pid: process.pid,
    allowedRoots: [...new Set(await Promise.all((options.allowedRoots ?? [project]).map(root => canonicalDirectory(resolve(root)))))].sort(),
    allowExec: options.allowExec ?? false, inputKeys, secretIds: [...new Set(options.secretIds ?? [])].sort(),
    dataDirectory,
    ...(dockerSocket ? { dockerSocket: resolve(dockerSocket) } : {}),
  };
  if (!ownerInfoSchema.safeParse(info).success) {
    throw new PreviewError('INVALID_INPUT', 'Invalid project launch options. Supply valid roots, input keys and secret names.');
  }
  const inputs: Record<string, string> = {};
  for (const key of inputKeys) {
    if (process.env[key] === undefined) throw new PreviewError('INVALID_INPUT', `The selected environment input ${key} is missing.`);
    inputs[key] = process.env[key]!;
  }
  return { info, inputs };
}

function startOwner(launch: ProjectLaunch): Promise<void> {
  if (process.platform !== 'darwin') throw new PreviewError('UNSUPPORTED_PLATFORM', 'Automatic project owners currently require macOS. Use an explicit daemon connection on other platforms.');
  return new Promise((done, reject) => {
    const child = fork(fileURLToPath(new URL('./owner-process.js', import.meta.url)), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    let settled = false;
    const timer = setTimeout(() => finish(new PreviewError('TIMEOUT', 'Project owner startup is still unresolved. Check the project connection before retrying.')), 15_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit');
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error); else done();
    };
    child.once('error', () => finish(new PreviewError('DAEMON_UNAVAILABLE', 'Cannot launch the project owner. Check the installed executable.')));
    child.once('exit', () => finish(new PreviewError('DAEMON_UNAVAILABLE', 'The project owner exited before readiness.')));
    child.once('message', (message: { error?: Failure; busy?: boolean }) => {
      if (message.error) finish(new PreviewError(message.error.code, message.error.message));
      else finish(); // A concurrent startup winner will publish the connection.
    });
    child.send(launch, error => { if (error) finish(new PreviewError('DAEMON_UNAVAILABLE', 'Cannot send project launch options.')); });
  });
}

/** Lazy CLI/MCP adapter. Only operations that begin new work may start a missing owner. */
export function connectProject(options: ProjectOptions = {}): ReturnType<typeof connectPreviewDaemon> {
  if (options.endpoint !== undefined || options.tokenFile !== undefined) {
    if ([options.allowedRoots, options.allowExec, options.inputKeys, options.secretIds, options.dataDirectory, options.dockerSocket].some(value => value !== undefined)) {
      throw new PreviewError('INVALID_INPUT', 'Explicit endpoint/token connections cannot change owner launch permissions. Configure the serving owner instead.');
    }
    return connectPreviewDaemon(options);
  }
  const project = managementProject(options.projectDirectory);
  const clients = new Set<ReturnType<typeof connectPreviewDaemon>>();
  const offlineOperations = new Set<Promise<unknown>>();
  const controller = new AbortController();
  let starting: Promise<void> | undefined;
  async function connect(create: boolean) {
    if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The project client is closed.');
    const root = await project;
    const directory = projectOwnerDirectory(root);
    let connection = await readConnection(directory);
    if (!connection && create) {
      if (!starting) starting = (async () => {
        const launch = await launchOptions(options, root);
        const deadline = performance.now() + 15_000;
        while (!await readConnection(directory)) {
          if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The project client is closed.');
          if (performance.now() >= deadline) throw new PreviewError('TIMEOUT', 'The project owner did not publish a connection. Check startup before retrying.');
          await startOwner(launch);
          // A winner may still be starting, or an old owner may be releasing its lock after shutdown.
          if (!await readConnection(directory)) await delay(100, undefined, { signal: controller.signal }).catch(() => { throw new PreviewError('CLOSED', 'The project client is closed.'); });
        }
      })().finally(() => { starting = undefined; });
      await starting;
      connection = await readConnection(directory);
    }
    if (!connection) throw new PreviewError('DAEMON_UNAVAILABLE', 'No project owner is running. Start a preview or request secret setup with the required launch permissions.');
    const client = connectPreviewDaemon({ endpoint: connection.endpoint, tokenFile: join(directory, 'token') });
    clients.add(client);
    try {
      const actual = ownerInfoSchema.safeParse(await client.info());
      if (!actual.success || actual.data.projectDirectory !== root) {
        throw new PreviewError('UNAUTHORIZED', 'The responding owner has a different project or incompatible owner information. Check the intended owner before retrying.');
      }
      const expected: Partial<ProjectOwnerInfo> = {};
      if (options.allowedRoots) expected.allowedRoots = [...new Set(await Promise.all(options.allowedRoots.map(path => canonicalDirectory(resolve(path)))))].sort();
      if (options.allowExec !== undefined) expected.allowExec = options.allowExec;
      if (options.inputKeys) expected.inputKeys = [...new Set(options.inputKeys)].sort();
      if (options.secretIds) expected.secretIds = [...new Set(options.secretIds)].sort();
      if (options.dataDirectory) expected.dataDirectory = resolve(options.dataDirectory);
      if (options.dockerSocket) expected.dockerSocket = resolve(options.dockerSocket);
      for (const key of Object.keys(expected) as Array<keyof ProjectOwnerInfo>) {
        if (!isDeepStrictEqual(expected[key], actual.data[key])) throw new PreviewError('INVALID_INPUT', `The owner for ${root} has different ${key}. Its permissions were not changed. To apply new options, explicitly shut down this project using CLI shutdown with --project set to that path and no launch overrides. This stops only that owner’s previews and ends its dynamic secret approvals; stored values and managed data remain. Other project owners are unaffected.`);
      }
      if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The project client is closed.');
      return client;
    } catch (error) {
      clients.delete(client); await client.close();
      if (error instanceof PreviewError && error.code === 'DAEMON_UNAVAILABLE') {
        throw new PreviewError('CLEANUP_INCOMPLETE', `The recorded project owner is unreachable. Retain sources and verify application cleanup. After cleanup, remove ${join(directory, 'connection.json')} and retry. Never infer cleanup from a dead endpoint.`);
      }
      throw error;
    }
  }
  async function call<T>(create: boolean, operation: (client: ReturnType<typeof connectPreviewDaemon>) => Promise<T>): Promise<T> {
    const client = await connect(create);
    try { return await operation(client); }
    finally { clients.delete(client); await client.close(); }
  }
  async function offline() {
    if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The project client is closed.');
    const directory = projectOwnerDirectory(await project);
    const record = await readProjectRecord(directory);
    if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The project client is closed.');
    return record && !record.endpoint ? { directory, record } : undefined;
  }
  async function runOffline<T>(work: Promise<T>): Promise<T> {
    offlineOperations.add(work);
    try { return await work; } finally { offlineOperations.delete(work); }
  }
  return {
    allowSources: (directories, signal) => call(true, client => client.allowSources(directories, signal)),
    describe: (name, id) => call(false, client => client.describe(name, id)),
    rerunJob: (name, id, job) => call(false, client => client.rerunJob(name, id, job)),
    startAgain: (name, id) => call(false, client => client.startAgain(name, id)),
    saveConfiguration: (name, id) => call(false, client => client.saveConfiguration(name, id)),
    secretsList: () => call(false, client => client.secretsList()),
    secretsOpen: (id, opts) => call(false, client => client.secretsOpen(id, opts)),
    remove: async (name, attemptId = null) => {
      const retained = await offline();
      if (retained) { await runOffline(removeOfflineProject(retained.directory)); return; }
      await call(false, client => client.remove(name, attemptId));
    },
    info: () => call(false, client => client.info()),
    inspect: async spec => {
      try { return await call(false, client => client.inspect(spec)); }
      catch (error) { if (!(error instanceof PreviewError) || error.code !== 'DAEMON_UNAVAILABLE') throw error; }
      // Offline inspection must not create a permissionless owner that blocks later authorized startup.
      const launch = await launchOptions(options, await project);
      const { createPreviewRuntime } = await import('./runtime.js');
      const runtime = await createPreviewRuntime({ allowedRoots: launch.info.allowedRoots, inputs: launch.inputs, secretIds: launch.info.secretIds });
      try {
        for (const directory of [projectOwnerDirectory(await project), ...(launch.info.dataDirectory ? [launch.info.dataDirectory] : [])]) {
          const exists = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
          if (exists) await runtime.protectDirectory(directory);
        }
        return await runtime.inspect(spec);
      } finally { await runtime.close(); }
    },
    start: spec => call(true, client => client.start(spec)),
    replace: (name, spec) => call(true, client => client.replace(name, spec)),
    list: async () => { const retained = await offline(); return retained ? offlinePreviews(retained.record) : call(false, client => client.list()); },
    get: async name => {
      const retained = await offline();
      if (!retained) return call(false, client => client.get(name));
      const preview = (await offlinePreviews(retained.record)).find(p => p.name === name);
      if (!preview) throw new PreviewError('NOT_FOUND', 'This preview is not retained.');
      return preview;
    },
    wait: (name, id, opts) => call(false, client => client.wait(name, id, opts)),
    logs: (name, id, options) => call(false, client => client.logs(name, id, options)),
    cancel: (name, id) => call(false, client => client.cancel(name, id)),
    stop: (name, opts) => call(false, client => client.stop(name, opts)),
    deleteData: async (name, deletion = {}) => {
      const retained = await offline();
      if (!retained) return call(false, client => client.deleteData(name, deletion));
      if (!options.allowExec) throw new PreviewError('EXECUTION_DENIED', 'Offline data deletion requires explicit permission. Use delete-data with --allow-exec.');
      return runOffline(deleteOfflineData(retained.directory, name, deletion, controller.signal));
    },
    secretsSetup: (spec, opts) => call(true, client => client.secretsSetup(spec, opts)),
    secretsEdit: (id, opts) => call(true, client => client.secretsEdit(id, opts)),
    secretsStatus: (id, opts) => call(false, client => client.secretsStatus(id, opts)),
    shutdown: () => call(false, async client => {
      const owner = await client.info();
      await client.shutdown();
      const directory = projectOwnerDirectory(await project);
      const deadline = performance.now() + 5000;
      while ((await readConnection(directory))?.pid === owner!.pid) {
        if (performance.now() >= deadline) throw new PreviewError('TIMEOUT', 'Runtime cleanup finished, but the owner has not removed its connection file. Check the original owner before restarting.');
        await delay(25);
      }
    }),
    close: async () => { controller.abort(); await Promise.all([...clients].map(client => client.close())); await Promise.allSettled(offlineOperations); },
  };
}
