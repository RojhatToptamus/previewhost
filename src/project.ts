import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { checkTokenDirectory, connectPreviewDaemon, type ClientOptions } from './client.js';
import { limits, secretIdSchema, type Failure } from './contracts.js';
import { PreviewError, failure } from './errors.js';
import { canonicalDirectory, isWithin } from './spec.js';

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

/** Discover records only; reading them never launches an owner or grants authority. */
export async function discoverProjectOwners(directory = join(homedir(), '.local', 'share', 'previewd', 'projects')) {
  const owners: Array<{ id: string; connection?: NonNullable<Awaited<ReturnType<typeof readConnection>>>; tokenFile: string; error?: Failure }> = [];
  const stat = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (!stat) return owners;
  await checkTokenDirectory(join(directory, 'token'));
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (owners.length >= 128) throw new PreviewError('BUSY', 'Too many project owners to display. Use the project CLI to inspect them.');
    const ownerDirectory = join(directory, entry.name);
    const tokenFile = join(ownerDirectory, 'token');
    try {
      const connection = await readConnection(ownerDirectory);
      if (!connection) continue;
      if (!isAbsolute(connection.projectDirectory) || createHash('sha256').update(connection.projectDirectory).digest('hex') !== entry.name) {
        throw new PreviewError('UNAUTHORIZED', 'The owner record does not match its project directory.');
      }
      owners.push({ id: entry.name, connection, tokenFile });
    } catch (error) { owners.push({ id: entry.name, tokenFile, error: failure(error) }); }
  }
  return owners;
}

async function readConnection(directory: string): Promise<{ endpoint: string; pid: number; projectDirectory: string } | undefined> {
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
    const record = z.strictObject({ endpoint: z.string(), pid: z.number().int().positive(), projectDirectory: directorySchema }).parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PreviewError('UNAUTHORIZED', 'The project connection file or its directory is unsafe or invalid.');
  } finally { await file?.close(); }
}

async function launchOptions(options: ProjectOptions, project: string): Promise<ProjectLaunch> {
  const inputKeys = [...new Set(options.inputKeys ?? [])].sort();
  const dataDirectory = options.dataDirectory ?? (options.dockerSocket ? join(projectOwnerDirectory(project), 'data') : undefined);
  const info = { projectDirectory: project, pid: process.pid,
    allowedRoots: [...new Set(await Promise.all((options.allowedRoots ?? [project]).map(root => canonicalDirectory(resolve(root)))))].sort(),
    allowExec: options.allowExec ?? false, inputKeys, secretIds: [...new Set(options.secretIds ?? [])].sort(),
    ...(dataDirectory ? { dataDirectory: resolve(dataDirectory) } : {}),
    ...(options.dockerSocket ? { dockerSocket: resolve(options.dockerSocket) } : {}),
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
  const project = projectDirectory(options.projectDirectory);
  const clients = new Set<ReturnType<typeof connectPreviewDaemon>>();
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
  return {
    allowSources: (directories, signal) => call(true, client => client.allowSources(directories, signal)),
    describe: (name, id) => call(false, client => client.describe(name, id)),
    startAgain: (name, id) => call(false, client => client.startAgain(name, id)),
    saveConfiguration: (name, id) => call(false, client => client.saveConfiguration(name, id)),
    secretsList: () => call(false, client => client.secretsList()),
    secretsOpen: (id, opts) => call(false, client => client.secretsOpen(id, opts)),
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
    list: () => call(false, client => client.list()),
    get: name => call(false, client => client.get(name)),
    wait: (name, id, opts) => call(false, client => client.wait(name, id, opts)),
    logs: (name, id, max) => call(false, client => client.logs(name, id, max)),
    cancel: (name, id) => call(false, client => client.cancel(name, id)),
    stop: (name, opts) => call(false, client => client.stop(name, opts)),
    deleteData: name => call(false, client => client.deleteData(name)),
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
    close: async () => { controller.abort(); await Promise.all([...clients].map(client => client.close())); },
  };
}
