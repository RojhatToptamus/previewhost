import { constants } from 'node:fs';
import { open, lstat, realpath, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { limits, nameSchema, type DataStatus, type OwnedDatabaseSpec, type StopOptions } from './contracts.js';
import { PreviewError, failure, throwIfAborted } from './errors.js';
import { Docker, object, defaultDockerEndpoint } from './docker.js';
import { databaseRedactions, probeDatabase } from './database-connections.js';
import { Keystore } from './keystore.js';
import { isPrivate, makePrivateDirectory, openOwnerLock, requireSupportedPlatform } from './private-files.js';
import { publishWindowsFile } from './windows.js';

export interface DatabaseBinding { url: string; redactions: string[] }
export interface DataOwner {
  readonly directory: string;
  names(): string[];
  status(name: string): DataStatus | undefined;
  open(name: string, resources: Record<string, OwnedDatabaseSpec>, options: { signal: AbortSignal; onFailure(error: Error): void }): Promise<Record<string, DatabaseBinding>>;
  stop(name: string, options?: StopOptions): Promise<void>;
  deleteData(name: string): Promise<void>;
  beginJob(name: string, job: string, rerun: boolean): Promise<boolean>;
  completeJob(name: string, job: string): Promise<void>;
  close(): Promise<void>;
}

const token = z.string().regex(/^[a-f0-9]{32}$/);
const objectName = z.string().regex(/^previewhost-[a-f0-9]{32}-(?:data|db)$/);
const containerId = z.string().regex(/^[a-f0-9]{64}$/);
const resourceSchema = z.strictObject({
  name: nameSchema, type: z.enum(['postgres', 'redis']),
  volume: objectName.optional(),
  container: z.strictObject({ name: objectName, id: containerId.optional() }).optional(),
  credentialRef: token,
});
const recordSchema = z.strictObject({
  schema: z.literal(3), resources: z.array(resourceSchema).min(1).max(limits.environmentDatabases),
  name: nameSchema, owner: token,
  jobs: z.record(nameSchema, z.enum(['started', 'succeeded'])).refine(value => Object.keys(value).length <= limits.terminalRecords).optional(),
  engine: z.strictObject({ id: z.string().min(1).max(128), socket: z.string().min(1).max(4096) }),
  pending: z.strictObject({ operation: z.enum(['create-volume', 'create-container', 'start-container', 'remove-container', 'remove-volume', 'remove-credential']), resource: nameSchema }).optional(),
});
type RecordData = z.infer<typeof recordSchema>;
type StoredResource = RecordData['resources'][number];
type Operation = NonNullable<RecordData['pending']>['operation'];
interface Entry { record: RecordData; cleanup?: DataStatus['cleanup'] }
interface Live {
  bindings: Record<string, DatabaseBinding>; controller: AbortController; waits: Promise<unknown>[];
  onFailure(error: Error): void; failed: boolean;
}
const fresh = () => randomBytes(16).toString('hex');
const cleanupError = (message: string) => new PreviewError('CLEANUP_INCOMPLETE', message);
async function retainedRecords(root: Awaited<ReturnType<typeof acquireRoot>>): Promise<RecordData[]> {
  const result: RecordData[] = [];
  for (const [filename, contents] of await root.records()) {
    let record: RecordData;
    try { record = recordSchema.parse(JSON.parse(contents)); }
    catch { throw cleanupError('This retained database record is unsupported or invalid. No data was changed. Use a new data directory; see the reset instructions in README.md.'); }
    if (filename !== `${record.name}.json` || record.owner !== root.owner
      || new Set(record.resources.map((item) => item.name)).size !== record.resources.length
      || (record.pending && !record.resources.some((item) => item.name === record.pending!.resource))
      || record.resources.some((item) => item.container && !item.volume)) throw cleanupError('A retained database record has inconsistent ownership.');
    if (record.pending) {
      const resource = record.resources.find((item) => item.name === record.pending!.resource)!;
      if (record.pending.operation === 'remove-credential') {
        if (record.resources.some((item) => item.volume || item.container)) throw cleanupError('Credential cleanup must follow Docker data removal.');
      } else if ((record.pending.operation.endsWith('volume') && !resource.volume)
        || (!record.pending.operation.endsWith('volume') && !resource.container)
        || (['start-container', 'remove-container'].includes(record.pending.operation) && !resource.container?.id)) {
        throw cleanupError('A retained database mutation is invalid.');
      }
    }
    result.push(record);
  }
  return result;
}

/** Read ownership records under their existing lock without Docker recovery, keystore access, or writes. */
export async function withRetainedData<T>(directory: string, read: (records: Array<{ name: string; data: DataStatus }>) => Promise<T>): Promise<T> {
  requireSupportedPlatform();
  const root = await acquireRoot(directory, true);
  try {
    const records = (await retainedRecords(root)).map(record => ({ name: record.name, data: {
      resources: record.resources.map(({ name, type }) => ({ name, type })), running: false,
      ...(record.pending || record.resources.some(resource => resource.container) ? { cleanup: {
        code: 'CLEANUP_INCOMPLETE' as const,
        message: 'Retained database cleanup is incomplete. Resolve cleanup before deleting data.',
        ...(record.pending?.operation === 'remove-credential' ? { operation: 'remove-credential' as const } : {}),
      } } : {}),
    } }));
    return await read(records);
  } finally { await root.close(); }
}

/** A retained data directory has one kernel-locked owner and one record per environment. */
export async function createDataOwner(options: { directory: string; dockerSocket?: string; keystore?: Keystore }): Promise<DataOwner> {
  requireSupportedPlatform();
  if (!isAbsolute(options.directory)) throw new PreviewError('INVALID_INPUT', 'The data directory must be absolute.');
  const keystore = options.keystore ?? new Keystore();
  const root = await acquireRoot(options.directory);
  const socketPath = options.dockerSocket ?? defaultDockerEndpoint();
  const entries = new Map<string, Entry>();
  const live = new Map<string, Live>();
  const locks = new Map<string, Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const serial = <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    if (closed || closing) return Promise.reject(new PreviewError('CLOSED', 'The data owner is closing.'));
    const previous = locks.get(name) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(operation);
    locks.set(name, work);
    void work.finally(() => { if (locks.get(name) === work) locks.delete(name); }).catch(() => {});
    return work;
  };
  const save = async (record: RecordData) => { await root.write(`${record.name}.json`, `${JSON.stringify(record)}\n`); };
  const engine = async (record?: RecordData) => {
    if (process.platform === 'win32') throw new PreviewError('UNSUPPORTED_PLATFORM', 'Windows managed databases are unavailable until Docker pipe server identity can be verified.');
    const docker = await Docker.connect(socketPath);
    const id = await docker.engineId();
    if (record && (record.engine.id !== id || record.engine.socket !== docker.socket)) {
      throw cleanupError('The retained databases belong to a different Docker engine or socket.');
    }
    return { docker, id };
  };
  const labels = (record: RecordData, resource: StoredResource, name: string) => ({
    'io.previewhost.owner': record.owner, 'io.previewhost.environment': record.name,
    'io.previewhost.resource': resource.name, 'io.previewhost.object': name,
  });
  const inspect = async (record: RecordData, resource: StoredResource, kind: 'volume' | 'container') => {
    const { docker } = await engine(record);
    const name = kind === 'volume' ? resource.volume : resource.container?.name;
    if (!name) return undefined;
    const reference = kind === 'container' ? resource.container?.id ?? name : name;
    const response = await docker.request('GET', kind === 'volume' ? `/volumes/${reference}` : `/containers/${reference}/json`);
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw cleanupError('An owned Docker resource could not be inspected.');
    const value = object(response.body);
    const actualLabels = object(kind === 'volume' ? value.Labels : object(value.Config).Labels);
    if (Object.entries(labels(record, resource, name)).some(([key, expected]) => actualLabels[key] !== expected)
      || (kind === 'volume' ? value.Name !== name : value.Name !== `/${name}` || !containerId.safeParse(value.Id).success
        || (resource.container?.id !== undefined && value.Id !== resource.container.id))) {
      throw cleanupError('Docker resource ownership changed; cleanup was refused.');
    }
    return value;
  };
  const mutate = async (record: RecordData, resource: StoredResource, operation: Operation,
    method: string, path: string, body: unknown, accepted: number[], apply: (response: unknown) => void, signal?: AbortSignal) => {
    let published = false;
    let dispatched = false;
    try {
      const { docker } = await engine(record);
      if (signal) throwIfAborted(signal);
      record.pending = { operation, resource: resource.name };
      await save(record); published = true;
      if (signal) throwIfAborted(signal);
      dispatched = true;
      const response = await docker.request(method, path, body);
      if (!accepted.includes(response.status)) throw cleanupError('A Docker mutation has an unresolved outcome; retained ownership must be reconciled.');
      apply(response.body);
      delete record.pending;
      await save(record);
    } catch (error) {
      if (!dispatched) {
        delete record.pending;
        if (operation === 'create-volume') delete resource.volume;
        if (operation === 'create-container') delete resource.container;
        if (published) await save(record);
      }
      throw error;
    }
  };
  const removeContainer = async (record: RecordData, resource: StoredResource) => {
    if (!resource.container) return;
    const found = await inspect(record, resource, 'container');
    if (!found) {
      delete resource.container; delete record.pending; await save(record); return;
    }
    resource.container.id = String(found.Id);
    await mutate(record, resource, 'remove-container', 'DELETE', `/containers/${resource.container.id}?force=1`, undefined, [204, 404], () => {});
    if (await inspect(record, resource, 'container')) throw cleanupError('The owned database container still exists after removal.');
    delete resource.container; await save(record);
  };
  const removeVolume = async (record: RecordData, resource: StoredResource) => {
    if (!resource.volume) return;
    if (!await inspect(record, resource, 'volume')) {
      delete resource.volume; delete record.pending; await save(record); return;
    }
    await mutate(record, resource, 'remove-volume', 'DELETE', `/volumes/${resource.volume}`, undefined, [204, 404], () => {});
    if (await inspect(record, resource, 'volume')) throw cleanupError('The owned database volume still exists after removal.');
    delete resource.volume; await save(record);
  };
  const resolvePending = async (record: RecordData, afterEngineRestart: boolean) => {
    const pending = record.pending;
    if (!pending) return;
    if (pending.operation === 'remove-credential') return; // Only explicit deletion retries the keystore cleanup.
    const resource = record.resources.find((item) => item.name === pending.resource)!;
    if (pending.operation === 'create-volume' || pending.operation === 'create-container') {
      const kind = pending.operation === 'create-volume' ? 'volume' : 'container';
      const found = await inspect(record, resource, kind);
      if (!found && !afterEngineRestart) {
        throw cleanupError('A pending Docker creation is absent but may still complete. After restarting the same engine, acknowledge recovery with afterEngineRestart.');
      }
      if (kind === 'container' && found) resource.container!.id = String(found.Id);
      if (!found) { if (kind === 'volume') delete resource.volume; else delete resource.container; }
      delete record.pending; await save(record);
    } else if (pending.operation === 'remove-volume') {
      await removeVolume(record, resource);
    } else {
      // Definitive removal of this exact ID also closes an indeterminate start.
      await removeContainer(record, resource);
    }
  };
  const stopLive = async (name: string) => {
    const current = live.get(name);
    if (!current) return;
    current.controller.abort();
    await Promise.allSettled(current.waits);
    live.delete(name);
  };
  const stopEntry = async (entry: Entry, stopOptions: StopOptions = {}) => {
    await stopLive(entry.record.name);
    if (entry.record.pending?.operation === 'remove-credential') {
      entry.cleanup = { code: 'CLEANUP_INCOMPLETE', message: 'Database credential removal is pending. Retry explicit data deletion after unlocking the keystore.' };
      return;
    }
    try {
      if (entry.record.pending || entry.record.resources.some((item) => item.container)) await engine(entry.record);
      await resolvePending(entry.record, stopOptions.afterEngineRestart === true);
      for (const resource of [...entry.record.resources].reverse()) await removeContainer(entry.record, resource);
      delete entry.cleanup;
    } catch (error) {
      entry.cleanup = failure(error, 'CLEANUP_INCOMPLETE');
      throw new PreviewError('CLEANUP_INCOMPLETE', entry.cleanup.message);
    }
  };
  const watch = (record: RecordData, docker: Docker, current: Live, resource: StoredResource) => {
    const work = docker.request('POST', `/containers/${resource.container!.id}/wait?condition=not-running`, undefined,
      { signal: current.controller.signal, timeoutMs: 0 }).then(() => {
      throw new Error('The database container exited.');
    }).catch(() => {
      if (current.controller.signal.aborted || current.failed) return;
      current.failed = true;
      current.onFailure(new PreviewError('START_FAILED', `The owned ${resource.name} database became unavailable.`));
    });
    current.waits.push(work);
    // Retain the observation until explicit cleanup joins it.
    live.set(record.name, current);
  };

  try {
    for (const record of await retainedRecords(root)) entries.set(record.name, { record });
  } catch (error) { await root.close(); throw error; }
  for (const entry of entries.values()) { await stopEntry(entry).catch(() => {}); }

  return {
    directory: root.directory,
    names() { return [...entries.keys()]; },
    status(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      return { resources: entry.record.resources.map(({ name, type }) => ({ name, type })), running: live.has(name),
        ...(entry.cleanup ? { cleanup: { ...entry.cleanup,
          ...(entry.record.pending?.operation === 'remove-credential' ? { operation: 'remove-credential' as const } : {}) } } : {}) };
    },
    open(name, resources, startOptions) {
      return serial(name, async () => {
        throwIfAborted(startOptions.signal);
        if (!nameSchema.safeParse(name).success || Object.keys(resources).length < 1 || Object.keys(resources).length > limits.environmentDatabases
          || Object.entries(resources).some(([id, spec]) => !nameSchema.safeParse(id).success || !['postgres', 'redis'].includes(spec.type))) {
          throw new PreviewError('INVALID_INPUT', 'The owned database resource set is invalid.');
        }
        let entry = entries.get(name);
        if (entry) {
          if (entry.cleanup) throw cleanupError(entry.cleanup.message);
          if (entry.record.resources.length !== Object.keys(resources).length || entry.record.resources.some((item) => resources[item.name]?.type !== item.type)) {
            throw new PreviewError('INVALID_INPUT', 'The retained database resource names and types differ. Stop and delete the retained data before changing them.');
          }
          const current = live.get(name);
          if (current) {
            if (current.failed) throw new PreviewError('START_FAILED', 'An owned database became unavailable.');
            current.onFailure = startOptions.onFailure;
            return structuredClone(current.bindings);
          }
        }
        const { docker, id } = await engine(entry?.record);
        const images = new Map<string, string>();
        for (const spec of Object.values(resources)) if (!images.has(spec.type)) images.set(spec.type, await docker.image(spec.type));
        throwIfAborted(startOptions.signal);
        if (!entry) {
          if (entries.size >= limits.retainedEnvironments) throw new PreviewError('BUSY', 'The retained environment limit was reached.');
          const record: RecordData = { schema: 3, name, owner: root.owner, engine: { id, socket: docker.socket },
            resources: Object.entries(resources).map(([name, spec]) => ({ name, type: spec.type, credentialRef: fresh() })) };
          entry = { record };
          entries.set(name, entry);
          try {
            for (const resource of record.resources) {
              throwIfAborted(startOptions.signal);
              const password = randomBytes(32).toString('hex');
              if (!await keystore.add('database', resource.credentialRef, password, { signal: startOptions.signal })
                || await keystore.get('database', resource.credentialRef, { signal: startOptions.signal }) !== password) {
                throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'The database credential could not be stored and verified.');
              }
            }
            await save(record);
          } catch (error) { entries.delete(name); throw error; }
        }
        const record = entry.record;
        const passwords = new Map<string, string>();
        for (const resource of record.resources) {
          const password = await keystore.get('database', resource.credentialRef, { signal: startOptions.signal });
          if (password === undefined) throw new PreviewError('SECRET_REQUIRED', 'A retained database credential is missing. Restore the encrypted keystore backup before opening this data. Never generate a replacement password for retained data.');
          if (!/^[a-f0-9]{64}$/.test(password)) throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'A retained database credential is invalid.');
          passwords.set(resource.name, password);
        }
        const current: Live = { bindings: {}, controller: new AbortController(), waits: [], onFailure: startOptions.onFailure, failed: false };
        try {
          await resolvePending(record, false);
          for (const resource of record.resources) {
            const password = passwords.get(resource.name)!;
            throwIfAborted(startOptions.signal);
            if (resource.container) throw cleanupError('An earlier owned database container still requires cleanup.');
            if (!resource.volume) {
              resource.volume = `previewhost-${fresh()}-data`;
              await mutate(record, resource, 'create-volume', 'POST', '/volumes/create',
                { Name: resource.volume, Driver: 'local', Labels: labels(record, resource, resource.volume) }, [201], () => {}, startOptions.signal);
            }
            if (!await inspect(record, resource, 'volume')) throw cleanupError('The retained data volume is missing. Explicit data deletion is required before recreation.');
            throwIfAborted(startOptions.signal);
            resource.container = { name: `previewhost-${fresh()}-db` };
            await mutate(record, resource, 'create-container', 'POST', `/containers/create?name=${resource.container.name}`,
              containerConfig(resource, images.get(resource.type)!, labels(record, resource, resource.container.name)), [201], (response) => {
                const id = object(response).Id;
                if (!containerId.safeParse(id).success) throw cleanupError('Docker did not return a valid container identity.');
                resource.container!.id = String(id);
              }, startOptions.signal);
            await inspect(record, resource, 'container');
            throwIfAborted(startOptions.signal);
            const attached = await docker.attach(resource.container.id!);
            try {
              throwIfAborted(startOptions.signal);
              await mutate(record, resource, 'start-container', 'POST', `/containers/${resource.container.id}/start`, undefined, [204], () => {}, startOptions.signal);
              attached.send(resource.type === 'postgres' ? `${password}\n`
                : `bind 0.0.0.0\nport 6379\nprotected-mode yes\nrequirepass ${password}\nappendonly yes\nappendfsync always\ndir /data\n`);
              throwIfAborted(startOptions.signal);
              const found = await inspect(record, resource, 'container');
              if (!found) throw cleanupError('The owned database container disappeared during startup.');
              const port = publishedPort(found, resource);
              const url = resource.type === 'postgres' ? `postgresql://previewhost:${password}@127.0.0.1:${port}/previewhost`
                : `redis://:${password}@127.0.0.1:${port}/0`;
              const deadline = performance.now() + 30_000;
              while (true) {
                throwIfAborted(startOptions.signal);
                try { await probeDatabase(resource.type, url, { signal: startOptions.signal, timeoutMs: 1500 }); break; }
                catch (error) { if (startOptions.signal.aborted || performance.now() >= deadline) throw error; }
                await pause(100, undefined, { signal: startOptions.signal });
              }
              current.bindings[resource.name] = { url, redactions: databaseRedactions(url) };
              watch(record, docker, current, resource);
            } finally { await attached.close(); }
          }
          throwIfAborted(startOptions.signal);
          if (current.failed) throw new PreviewError('START_FAILED', 'An owned database exited during startup.');
          delete entry.cleanup;
          return structuredClone(current.bindings);
        } catch (error) {
          await stopEntry(entry).catch(() => {});
          if (entry.cleanup) throw cleanupError(entry.cleanup.message);
          throw error;
        }
      });
    },
    stop(name, stopOptions) {
      if (closed) return Promise.resolve();
      return serial(name, async () => { const entry = entries.get(name); if (entry) await stopEntry(entry, stopOptions); });
    },
    beginJob(name, job, rerun) {
      return serial(name, async () => {
        const record = entries.get(name)?.record;
        if (!record || !live.has(name)) throw new PreviewError('START_FAILED', 'Once-only jobs require running owned data.');
        const jobs = record.jobs ?? {};
        if (!rerun && jobs[job] === 'succeeded') return false;
        if (!rerun && jobs[job] === 'started') throw new PreviewError('START_FAILED', `Job ${job} previously failed or was interrupted. Inspect its writes, then explicitly rerun the job or stop and delete data. No writes were rolled back.`);
        if (!Object.hasOwn(jobs, job) && Object.keys(jobs).length >= limits.terminalRecords) throw new PreviewError('BUSY', 'The retained job limit was reached. Delete this disposable data before adding more jobs.');
        record.jobs = { ...jobs, [job]: 'started' };
        // Durable intent precedes execution. An uncertain write or owner exit cannot silently rerun a seed.
        await save(record);
        return true;
      });
    },
    completeJob(name, job) {
      return serial(name, async () => {
        const record = entries.get(name)?.record;
        if (!record || record.jobs?.[job] !== 'started') throw cleanupError('The job completion has no retained execution record.');
        // Publish before changing memory, so a failed save cannot make a retry skip uncertain work.
        const completed = { ...record, jobs: { ...record.jobs, [job]: 'succeeded' as const } };
        await save(completed);
        entries.get(name)!.record = completed;
      });
    },
    deleteData(name) {
      return serial(name, async () => {
        const entry = entries.get(name);
        if (!entry) return;
        if (live.has(name) || entry.record.resources.some((item) => item.container)
          || entry.record.pending && entry.record.pending.operation !== 'remove-credential') {
          throw new PreviewError('BUSY', 'Stop and reconcile the owned databases before deleting data.');
        }
        try {
          for (const resource of entry.record.resources) await removeVolume(entry.record, resource);
          for (const resource of entry.record.resources) {
            entry.record.pending = { operation: 'remove-credential', resource: resource.name };
            await save(entry.record);
            await keystore.remove('database', resource.credentialRef);
          }
          await root.remove(`${name}.json`);
          entries.delete(name);
        } catch (error) { entry.cleanup = failure(error, 'CLEANUP_INCOMPLETE'); throw error; }
      });
    },
    close() {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        await Promise.allSettled(locks.values());
        let error: unknown;
        for (const entry of entries.values()) { try { await stopEntry(entry); } catch (cause) { error ??= cause; } }
        if (error) throw error;
        await root.close();
        if (!options.keystore) keystore.close();
        closed = true;
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
}

function containerConfig(resource: StoredResource, image: string, labels: Record<string, string>): unknown {
  const postgres = resource.type === 'postgres';
  const port = postgres ? '5432/tcp' : '6379/tcp';
  return {
    Image: image, Labels: labels, OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
    ExposedPorts: { [port]: {} },
    ...(postgres ? { Entrypoint: ['/bin/sh', '-c'],
      Cmd: ['IFS= read -r POSTGRES_PASSWORD || exit 9; test "${#POSTGRES_PASSWORD}" = 64 || exit 9; export POSTGRES_PASSWORD; exec docker-entrypoint.sh postgres'],
      Env: ['POSTGRES_USER=previewhost', 'POSTGRES_DB=previewhost'] } : { Cmd: ['redis-server', '-'] }),
    HostConfig: { AutoRemove: false, RestartPolicy: { Name: 'no' }, NetworkMode: 'bridge',
      Memory: 536_870_912, NanoCpus: 1_000_000_000, PidsLimit: 128,
      PortBindings: { [port]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Mounts: [{ Type: 'volume', Source: resource.volume, Target: postgres ? '/var/lib/postgresql/data' : '/data' }],
      LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } },
    },
  };
}

function publishedPort(container: Record<string, unknown>, resource: StoredResource): number {
  const ports = object(object(container.NetworkSettings).Ports);
  const bindings = ports[resource.type === 'postgres' ? '5432/tcp' : '6379/tcp'];
  if (!Array.isArray(bindings) || bindings.length !== 1 || object(bindings[0]).HostIp !== '127.0.0.1'
    || !/^[1-9][0-9]{0,4}$/.test(String(object(bindings[0]).HostPort))) throw cleanupError('The owned database has an unexpected published address.');
  const port = Number(object(bindings[0]).HostPort);
  const mounts = container.Mounts;
  if (port > 65535 || !Array.isArray(mounts) || mounts.length !== 1 || object(mounts[0]).Name !== resource.volume
    || object(mounts[0]).Destination !== (resource.type === 'postgres' ? '/var/lib/postgresql/data' : '/data')) {
    throw cleanupError('The owned database has unexpected mounts or ports.');
  }
  return port;
}

async function acquireRoot(directory: string, readOnly = false) {
  let handle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  try {
    if (!readOnly) makePrivateDirectory(directory);
    const before = await lstat(directory);
    if (!before.isDirectory() || !isPrivate(directory, before)) throw new Error();
    directory = await realpath(directory);
    if (process.platform !== 'win32') directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const lockPath = join(directory, '.lock');
    // The lock inode also retains the stable data owner identifier.
    handle = await openOwnerLock(lockPath, !readOnly);
    const lock = await handle.stat();
    if (!lock.isFile() || lock.nlink !== 1 || !isPrivate(lockPath, lock) || lock.size > 64) throw new Error();
    let owner = (await handle.readFile('utf8')).trim();
    if (!owner && !readOnly) { owner = fresh(); await handle.write(`${owner}\n`, 0, 'utf8'); await handle.sync(); await directoryHandle?.sync(); }
    if (!token.safeParse(owner).success) throw new Error();
    const assertRoot = async () => {
      const current = await lstat(lockPath);
      const root = await lstat(directory);
      if (current.dev !== lock.dev || current.ino !== lock.ino || current.nlink !== 1 || !isPrivate(lockPath, current)
        || !root.isDirectory() || root.dev !== before.dev || root.ino !== before.ino || !isPrivate(directory, root)) {
        throw cleanupError('The private data directory or permanent ownership lock changed.');
      }
    };
    const read = async (filename: string) => {
      if (!(await lstat(join(directory, filename))).isFile()) throw cleanupError('A retained database record is not a regular file.');
      const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || !isPrivate(join(directory, filename), info) || info.size > 65_536) {
          throw cleanupError('A retained database record has unsafe size, ownership or permissions.');
        }
        const buffer = Buffer.alloc(65_537);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== info.size || bytesRead > 65_536) throw cleanupError('A retained database record changed while reading.');
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
    };
    return {
      owner, directory,
      async records(): Promise<Array<[string, string]>> {
        await assertRoot();
        const files: string[] = [];
        for await (const entry of await opendir(directory)) {
          files.push(entry.name);
          if (files.length > limits.retainedEnvironments * 2 + 1) throw cleanupError('The private data directory contains too many records.');
        }
        const records: Array<[string, string]> = [];
        for (const filename of files) {
          if (filename === '.lock') continue;
          if (/^\.record-[a-f0-9]{32}\.tmp$/.test(filename)) { await read(filename); if (!readOnly) await unlink(join(directory, filename)); continue; }
          if (!/^[a-z][a-z0-9-]{0,47}\.json$/.test(filename)) throw cleanupError('The private data directory contains an unknown file.');
          records.push([filename, await read(filename)]);
        }
        if (records.length > limits.retainedEnvironments) throw cleanupError('The retained environment limit was exceeded.');
        return records;
      },
      async write(filename: string, value: string) {
        await assertRoot();
        const temporary = join(directory, `.record-${fresh()}.tmp`);
        let file: FileHandle | undefined;
        try {
          file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await file.writeFile(value); await file.sync(); await file.close(); file = undefined;
          await assertRoot();
          if (process.platform === 'win32') publishWindowsFile(temporary, join(directory, filename));
          else { await rename(temporary, join(directory, filename)); await directoryHandle!.sync(); }
        } catch {
          throw cleanupError('The database ownership record could not be published.');
        } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
      },
      async remove(filename: string) { await assertRoot(); await unlink(join(directory, filename)); await directoryHandle?.sync(); },
      async close() { await directoryHandle?.close(); await handle!.close(); },
    };
  } catch (error) {
    await directoryHandle?.close(); await handle?.close();
    const code = (error as NodeJS.ErrnoException).code;
    throw new PreviewError(code === 'EAGAIN' || code === 'EWOULDBLOCK' ? 'BUSY' : 'CLEANUP_INCOMPLETE',
      code === 'EAGAIN' || code === 'EWOULDBLOCK' ? 'Another owner holds the data directory.' : 'The private data directory could not be locked safely.');
  }
}
