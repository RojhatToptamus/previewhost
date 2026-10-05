import { randomUUID } from 'node:crypto';
import { realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { acquireRoot } from './data.js';
import { Docker, defaultDockerEndpoint, object } from './docker.js';
import { PreviewError, throwIfAborted } from './errors.js';
import { nameSchema, type ComposeSpec, type DataStatus, type RuntimeOptions, type ServiceStatus } from './contracts.js';
import { ComposeCli } from './compose-cli.js';
import { prepareCompose, type PreparedCompose, type ComposeServiceInspection } from './compose-inspection.js';
import { browserHostname } from './spec.js';
import { makePrivateDirectory } from './private-files.js';
import { waitForHttp, waitForTcp } from './readiness.js';
import type { NativeOwnership } from './native.js';
import type { HttpTarget, Resource } from './resources.js';

const OWNER = 'io.previewhost.compose-owner';
const GROUP = 'io.previewhost.compose-attempt';
const volumeSchema = z.strictObject({ name: nameSchema, physical: z.string().regex(/^ph-[a-f0-9-]+-[a-z0-9-]+$/), driver: z.string().optional(),
  // External writes made under this image/layout are not reversed by a preview update.
  consumers: z.array(z.string().max(65536)).max(64) });
const recordSchema = z.strictObject({ name: nameSchema, owner: z.uuid(), socket: z.string().max(4096), engine: z.string().max(128),
  volumes: z.array(volumeSchema).max(64), projects: z.array(z.strictObject({ id: z.uuid(), containers: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64), networks: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64) })).max(16) });
type ComposeRecord = z.output<typeof recordSchema>;
type Root = Awaited<ReturnType<typeof acquireRoot>>;

/** One concrete owner for Compose containers, networks and retained named volumes. */
export class ComposeOwner {
  private readonly records = new Map<string, ComposeRecord>();
  private readonly cleanup = new Map<string, DataStatus['cleanup']>();
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private readonly root: Root, private readonly commands: string, private readonly socket: string) {}

  static async open(directory: string, socket = defaultDockerEndpoint()): Promise<ComposeOwner> {
    makePrivateDirectory(directory);
    directory = await realpath(directory);
    const root = await acquireRoot(join(directory, 'records'), false, 1048576);
    try {
      const commands = join(directory, 'commands');
      makePrivateDirectory(commands);
      const owner = new ComposeOwner(root, commands, socket);
      for (const [filename, text] of await root.records()) {
        const record = recordSchema.parse(JSON.parse(text));
        if (filename !== `${record.name}.json`) throw new Error();
        owner.records.set(record.name, record);
      }
      return owner;
    } catch {
      await root.close();
      throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose ownership records are invalid. Preserve them before recovery.');
    }
  }

  get directory(): string { return dirname(this.root.directory); }

  names(): string[] { return [...this.records.keys()]; }
  status(name: string): DataStatus | undefined {
    const record = this.records.get(name);
    if (!record || !record.volumes.length && !record.projects.length && !this.cleanup.has(name)) return;
    return { resources: record.volumes.map(volume => ({ name: volume.name, type: 'compose-volume' })), running: !!record.projects.length,
      ...(this.cleanup.has(name) ? { cleanup: this.cleanup.get(name) } : {}) };
  }

  async prepare(spec: ComposeSpec, signal: AbortSignal): Promise<{ cli: ComposeCli; prepared: PreparedCompose }> {
    const cli = await ComposeCli.create(this.commands, this.socket);
    try { return { cli, prepared: await prepareCompose(spec, cli, signal) }; }
    catch (error) { await cli.close(); throw error; }
  }

  private save(record: ComposeRecord): Promise<void> {
    const work = this.pending.then(async () => {
      await this.root.write(`${record.name}.json`, JSON.stringify(recordSchema.parse(record)));
      this.records.set(record.name, structuredClone(record));
    });
    this.pending = work.catch(() => undefined);
    return work;
  }

  private async engine(record: ComposeRecord): Promise<Docker> {
    const docker = await Docker.connect(record.socket);
    if (await docker.engineId() !== record.engine) throw new PreviewError('CLEANUP_INCOMPLETE', 'The Compose project belongs to a different Docker Engine. Restore its recorded local engine before cleanup.');
    return docker;
  }

  async start(spec: ComposeSpec, input: { cli: ComposeCli; prepared: PreparedCompose; signal: AbortSignal;
    supervisor?: RuntimeOptions['supervisor']; ownership?(): NativeOwnership; beforeActivation(): Promise<void>;
    url: string; appendLog(text: string, source: string): void; serviceStatus(id: string, status: ServiceStatus): void; onResource(resource: Resource): void;
  }): Promise<Resource> {
    const docker = await Docker.connect(this.socket);
    let record = this.records.get(spec.name);
    if (!record) {
      record = { name: spec.name, owner: randomUUID(), socket: docker.socket, engine: await docker.engineId(), volumes: [], projects: [] };
      await this.save(record);
    }
    await this.engine(record);
    const project = randomUUID();
    const labels = { [OWNER]: record.owner, [GROUP]: project };
    const configuration = structuredClone(input.prepared.configuration);
    const services = object(configuration.services);
    const volumes = object(configuration.volumes);
    const networks = object(configuration.networks);
    for (const volume of input.prepared.description.volumes) {
      if (volume.external && record.volumes.some(value => value.name === volume.name)) throw new PreviewError('INVALID_INPUT', `Volume ${volume.name} changed ownership. Delete retained data explicitly before changing its owner.`);
      if (volume.external) continue;
      const consumers = input.prepared.description.services.filter(service => service.namedVolumes.some(mount => mount.source === volume.name && !mount.readOnly))
        .map(dataCompatibility).sort();
      const previous = record.volumes.find(value => value.name === volume.name);
      if (previous && (previous.driver !== volume.driver || !isDeepStrictEqual(previous.consumers, consumers))) {
        throw new PreviewError('INVALID_INPUT', `Volume ${volume.name} has an incompatible image or layout change. Stop and explicitly delete retained data before applying it.`);
      }
      if (!previous) {
        record = { ...record, volumes: [...record.volumes, { name: volume.name, physical: `ph-${record.owner}-${volume.name}`, driver: volume.driver, consumers }] };
        await this.save(record);
      }
    }
    for (const volume of record.volumes) {
      if (!Object.hasOwn(volumes, volume.name)) continue;
      const inspected = await docker.request('GET', `/volumes/${encodeURIComponent(volume.physical)}`);
      if (inspected.status === 404) {
        const created = await docker.request('POST', '/volumes/create', { Name: volume.physical, Driver: volume.driver ?? 'local', Labels: { [OWNER]: record.owner } });
        if (created.status !== 201) throw new PreviewError('START_FAILED', 'Compose volume creation failed.');
        assertLabels(created.body, { [OWNER]: record.owner });
      } else if (inspected.status === 200) assertLabels(inspected.body, { [OWNER]: record.owner });
      else throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose volume identity is unavailable.');
      volumes[volume.name] = { name: volume.physical, external: true };
    }
    configuration.volumes = volumes;
    for (const network of input.prepared.description.networks.filter(value => !value.external)) {
      networks[network.name] = { ...object(networks[network.name]), name: `ph-${project}-${network.name}`, labels };
    }
    configuration.networks = networks;
    for (const [id, value] of Object.entries(services)) {
      const service = object(value);
      service.labels = labels;
      const exposure = spec.services.find(value => value.id === id);
      service.ports = Object.values(exposure?.ports ?? {}).map(port => ({ target: port.target, published: '0', host_ip: '127.0.0.1', protocol: 'tcp' }));
      // Materialized values are the execution input; do not reread env files after authorization.
      delete service.env_file;
      input.serviceStatus(id, { type: 'compose', state: 'waiting' });
    }
    for (const [id, value] of Object.entries(input.prepared.secretFiles)) {
      const file = join(input.cli.directory, `secret-${randomUUID()}`);
      await writeFile(file, value, { mode: 0o600, flag: 'wx' });
      object(configuration.secrets)[id] = { file };
    }
    const file = join(input.cli.directory, 'compose.json');
    await writeFile(file, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' });
    let command: Pick<Resource, 'stop'> | undefined;
    const readers: Array<Pick<Resource, 'stop'>> = [];
    let stopped = false;
    let stopWork: Promise<void> | undefined;
    let monitor: NodeJS.Timeout | undefined;
    let checking: Promise<void> = Promise.resolve();
    let lost!: (error: Error) => void;
    const exited = new Promise<Error>(resolve => { lost = resolve; });
    const resource: Resource = { target: { port: 0, hostHeader: '' }, exited,
      stop: () => stopWork ??= (async () => {
        stopped = true;
        clearTimeout(monitor);
        await command?.stop();
        for (const reader of readers) await reader.stop();
        await checking;
        await this.stopProject(spec.name, project);
        await input.cli.close();
      })().catch(error => { stopWork = undefined; throw error; }),
    };
    input.onResource(resource);
    const run = (args: string[]) => input.cli.run(spec, `ph-${project}`, file, args, {
      supervisor: input.supervisor, ownership: input.ownership?.(), signal: input.signal, redactions: input.prepared.redactions,
      onResource: value => { command = value; }, appendLog: text => input.appendLog(text, spec.name),
    });
    if (input.prepared.description.services.some(service => service.build)) await run(['build', ...spec.rootServices]);
    throwIfAborted(input.signal);
    // A Compose update may write existing volumes. Never run both applications against them.
    await input.beforeActivation();
    throwIfAborted(input.signal);
    record = this.records.get(spec.name)!;
    await this.save({ ...record, projects: [...record.projects, { id: project, containers: [], networks: [] }] });
    for (const id of Object.keys(services)) input.serviceStatus(id, { type: 'compose', state: 'starting' });
    const capture = async (containers: Record<string, unknown>[], follow = true) => {
      for (const container of containers) {
        const service = String(object(object(container.Config).Labels)['com.docker.compose.service']);
        const reader = await input.cli.capture(container.Id as string, follow, {
          signal: input.signal, supervisor: input.supervisor, ownership: input.ownership?.(), redactions: input.prepared.redactions,
          appendLog: text => input.appendLog(text, service), onResource: reader => { readers.push(reader); },
        });
        void reader?.exited?.then(() => { if (!stopped) input.appendLog('Container log capture ended. Captured output remains available.\n', service); });
      }
    };
    try {
      await run(['up', '--detach', '--wait', '--wait-timeout', String(Math.ceil(spec.timeoutMs / 1000)), '--pull', 'missing', '--no-build', ...spec.rootServices]);
    } catch (error) {
      // Observe failure output before exact owned-container cleanup. A canceled attempt does not start new readers.
      if (!input.signal.aborted) await capture(await this.observeProject(spec.name, project, docker), false);
      throw error;
    }
    throwIfAborted(input.signal);
    const containers = await this.observeProject(spec.name, project, docker);
    await capture(containers);
    const routes: Record<string, HttpTarget> = {};
    for (const service of spec.services) {
      const container = containers.find(value => object(object(value.Config).Labels)['com.docker.compose.service'] === service.id);
      if (!container) throw new PreviewError('START_FAILED', `Compose service ${service.id} has no owned container.`);
      const ports: Record<string, number> = {};
      for (const [id, port] of Object.entries(service.ports)) {
        const bindings = object(container.NetworkSettings).Ports as Record<string, unknown> | undefined;
        const bound = bindings?.[`${port.target}/tcp`];
        if (!Array.isArray(bound) || bound.length !== 1 || object(bound[0]).HostIp !== '127.0.0.1') throw new PreviewError('START_FAILED', 'Compose did not publish the selected port only on loopback.');
        const number = Number(object(bound[0]).HostPort);
        if (!Number.isInteger(number) || number < 1 || number > 65535) throw new PreviewError('START_FAILED', 'Compose published an invalid port.');
        ports[id] = number;
        const target = { port: number, hostHeader: `127.0.0.1:${number}` };
        for (const [name, route] of Object.entries(spec.routes)) {
          if (route.service === service.id && route.port === id) routes[browserHostname(spec.name, name)] = target;
        }
        if (spec.primary.service === service.id && spec.primary.port === id) resource.target = target;
      }
      if (service.ready) {
        const port = ports[service.ready.port];
        if (!port) throw new PreviewError('INVALID_INPUT', 'Compose readiness refers to an undeclared port.');
        if (service.ready.type === 'http') await waitForHttp({ port, hostHeader: `127.0.0.1:${port}` }, service.ready.path, service.ready.timeoutMs, input.signal);
        else await waitForTcp(port, service.ready.timeoutMs, input.signal);
      }
    }
    if (!resource.target.port) throw new PreviewError('INVALID_INPUT', 'Compose primary must select an exposed service port.');
    resource.routes = { ...routes, '127.0.0.1': resource.target };
    for (const id of Object.keys(services)) {
      const route = Object.entries(spec.routes).find(([, route]) => route.service === id);
      input.serviceStatus(id, { type: 'compose', state: 'ready',
        ...(id === spec.primary.service ? { url: input.url, browserUrl: input.url } :
          route ? { browserUrl: `http://${browserHostname(spec.name, route[0])}:${new URL(input.url).port}` } : {}),
      });
    }
    const check = async () => {
      if (stopped) return;
      try {
        await this.engine(this.records.get(spec.name)!);
        const observed = await this.containers(docker, labels);
        if (!observed.length || observed.some(value => object(value.State).Running !== true || object(value.State).Paused === true || object(value.State).Restarting === true)) {
          throw new PreviewError('START_FAILED', 'An owned Compose service stopped.');
        }
      } catch { if (!stopped) lost(new PreviewError('START_FAILED', 'Compose service health or ownership could not be verified.')); return; }
      if (!stopped) monitor = setTimeout(() => { checking = check(); }, 5000);
    };
    monitor = setTimeout(() => { checking = check(); }, 5000);
    return resource;
  }

  private async containers(docker: Docker, labels: Record<string, string>): Promise<Record<string, unknown>[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) }));
    const listed = await docker.request('GET', `/containers/json?all=1&filters=${filters}`);
    if (listed.status !== 200 || !Array.isArray(listed.body)) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose container inventory is unavailable.');
    return Promise.all(listed.body.map(async value => {
      const id = object(value).Id;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose container identity is invalid.');
      const result = await docker.request('GET', `/containers/${id}/json`);
      if (result.status !== 200 || object(result.body).Id !== id) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose container identity changed.');
      assertLabels(object(result.body).Config, labels);
      return object(result.body);
    }));
  }

  private async observeProject(name: string, project: string, docker: Docker): Promise<Record<string, unknown>[]> {
    const record = this.records.get(name)!;
    const labels = { [OWNER]: record.owner, [GROUP]: project };
    const containers = await this.containers(docker, labels);
    const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) }));
    const networks = await docker.request('GET', `/networks?filters=${filters}`);
    if (networks.status !== 200 || !Array.isArray(networks.body)) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose network inventory is unavailable.');
    const ids = networks.body.map(value => {
      const id = object(value).Id;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose network identity is invalid.');
      assertLabels(value, labels);
      return id;
    });
    await this.save({ ...record, projects: record.projects.map(value => value.id === project ? {
      id: project, containers: [...new Set([...value.containers, ...containers.map(value => value.Id as string)])], networks: [...new Set([...value.networks, ...ids])],
    } : value) });
    return containers;
  }

  private async stopProject(name: string, project: string): Promise<void> {
    const record = this.records.get(name);
    if (!record?.projects.some(value => value.id === project)) return;
    try {
      const docker = await this.engine(record);
      const labels = { [OWNER]: record.owner, [GROUP]: project };
      await this.observeProject(name, project, docker);
      const known = this.records.get(name)!.projects.find(value => value.id === project)!;
      for (const id of known.containers) {
        const inspected = await docker.request('GET', `/containers/${id}/json`);
        if (inspected.status === 404) continue;
        if (inspected.status !== 200 || object(inspected.body).Id !== id) throw new Error();
        assertLabels(object(inspected.body).Config, labels);
        const stopped = await docker.request('POST', `/containers/${id}/stop?t=10`);
        if (![204, 304].includes(stopped.status)) throw new Error();
        if ((await docker.request('DELETE', `/containers/${id}`)).status !== 204) throw new Error();
        if ((await docker.request('GET', `/containers/${id}/json`)).status !== 404) throw new Error();
      }
      for (const id of known.networks) {
        const result = await docker.request('GET', `/networks/${id}`);
        if (result.status === 404) continue;
        if (result.status !== 200 || object(result.body).Id !== id) throw new Error();
        assertLabels(result.body, labels);
        if ((await docker.request('DELETE', `/networks/${id}`)).status !== 204) throw new Error();
        if ((await docker.request('GET', `/networks/${id}`)).status !== 404) throw new Error();
      }
      await this.save({ ...this.records.get(name)!, projects: this.records.get(name)!.projects.filter(value => value.id !== project) });
      this.cleanup.delete(name);
    } catch {
      this.cleanup.set(name, { code: 'CLEANUP_INCOMPLETE', message: 'Compose cleanup is incomplete. Restore its local Docker Engine and retry Stop.' });
      throw new PreviewError('CLEANUP_INCOMPLETE', this.cleanup.get(name)!.message);
    }
  }

  async stop(name: string): Promise<void> {
    for (const project of this.records.get(name)?.projects ?? []) await this.stopProject(name, project.id);
    const record = this.records.get(name);
    if (record && !record.volumes.length && !record.projects.length) { await this.root.remove(`${name}.json`); this.records.delete(name); }
  }

  async deleteData(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    if (record.projects.length) throw new PreviewError('BUSY', 'Stop Compose before deleting its data.');
    const docker = await this.engine(record);
    for (const volume of [...record.volumes]) {
      const inspected = await docker.request('GET', `/volumes/${encodeURIComponent(volume.physical)}`);
      if (inspected.status === 200) {
        assertLabels(inspected.body, { [OWNER]: record.owner });
        if ((await docker.request('DELETE', `/volumes/${encodeURIComponent(volume.physical)}`)).status !== 204) throw new PreviewError('CLEANUP_INCOMPLETE', 'A Compose volume is still in use.');
      } else if (inspected.status !== 404) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose volume deletion could not verify ownership.');
      if ((await docker.request('GET', `/volumes/${encodeURIComponent(volume.physical)}`)).status !== 404) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose volume deletion could not verify absence.');
      await this.save({ ...this.records.get(name)!, volumes: this.records.get(name)!.volumes.filter(value => value.name !== volume.name) });
    }
    await this.root.remove(`${name}.json`);
    this.records.delete(name);
    this.cleanup.delete(name);
  }

  async clearStoppedCommands(): Promise<void> {
    const entries = await readdir(this.commands);
    if (entries.some(name => !/^command-[A-Za-z0-9]+$/.test(name))) throw new PreviewError('CLEANUP_INCOMPLETE', 'The Compose command directory contains unknown files. Preserve it before recovery.');
    for (const name of entries) await rm(join(this.commands, name), { recursive: true, force: true });
  }

  async close(): Promise<void> { await this.pending; await this.root.close(); }
}

function assertLabels(value: unknown, expected: Record<string, string>) {
  const labels = object(object(value).Labels);
  if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) throw new PreviewError('CLEANUP_INCOMPLETE', 'Compose resource ownership labels do not match. No resource was removed.');
}

function dataCompatibility(service: ComposeServiceInspection): string {
  return JSON.stringify({ id: service.id, image: service.image, platform: service.platform, build: service.build, command: service.command,
    entrypoint: service.entrypoint, user: service.user, directory: service.workingDirectory, secrets: service.secretSources, volumes: service.namedVolumes });
}
