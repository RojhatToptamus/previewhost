import type { EnvironmentSpec, EnvironmentValue, ServiceStatus } from './contracts.js';
import { limits } from './contracts.js';
import { PreviewError, failure, throwIfAborted } from './errors.js';
import { startNative, type NativeResource } from './native.js';
import { startStatic } from './static.js';
import { createGateway } from './gateway.js';
import { waitForHttp } from './readiness.js';
import { attachmentTarget, browserHostname, environmentDependencies, isHttpService, resolveInput } from './spec.js';
import { databaseRedactions, probeDatabase } from './database-connections.js';
import type { DatabaseBinding } from './data.js';
import type { HttpTarget, Resource } from './resources.js';

/** One attempt owns this application graph. Database handles belong to its slot. */
export async function startEnvironment(input: {
  spec: EnvironmentSpec;
  url: string;
  inputs: Readonly<Record<string, string>>;
  databases: Readonly<Record<string, DatabaseBinding>>;
  privateDirectory?: string;
  signal: AbortSignal;
  appendLog(text: string): void;
  serviceStatus(id: string, status: ServiceStatus): void;
  onResource(resource: Resource): void;
}): Promise<Resource> {
  const { spec } = input;
  const graph = environmentDependencies(spec);
  const controller = new AbortController();
  const running = new Map<string, Resource>();
  const connections = new Map<string, DatabaseBinding>();
  const starts = new Map<string, Promise<void>>();
  const failures = new Map<string, Error>();
  const semaphore = new Semaphore();
  let stopping = false;
  let stopWork: Promise<void> | undefined;
  let unexpected: Error | undefined;
  let notifyExit!: (error: Error) => void;
  const exited = new Promise<Error>((resolve) => { notifyExit = resolve; });
  const onAbort = () => controller.abort();
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  const port = new URL(input.url).port;
  const browserUrl = (id: string) => `http://${browserHostname(spec.name, id)}:${port}`;
  const status = (id: string, state: ServiceStatus['state'], error?: Error) => {
    const service = spec.services[id];
    if (state === 'failed' && error) failures.set(id, error);
    input.serviceStatus(id, {
      type: service.type, state,
      ...(isHttpService(service) ? { browserUrl: browserUrl(id), ...(id === spec.primary ? { url: input.url } : {}) } : {}),
      ...(error ? { error: failure(error) } : {}),
    });
  };
  for (const id of graph.keys()) status(id, 'waiting');

  const resource: Resource = {
    get target() {
      const primary = running.get(spec.primary);
      if (!primary) throw new PreviewError('START_FAILED', 'The environment entry service is not ready.');
      return primary.target;
    },
    get routes() {
      const routes: Record<string, HttpTarget> = { '127.0.0.1': resource.target };
      for (const [id, value] of running) routes[browserHostname(spec.name, id)] = value.target;
      return routes;
    },
    exited,
    assertRunning,
    stop,
  };
  input.onResource(resource);

  function assertRunning(): void {
    if (unexpected) throw unexpected;
    throwIfAborted(controller.signal);
    if (stopping) throw new PreviewError('CLOSED', 'The environment was stopped.');
    for (const value of running.values()) value.assertRunning?.();
  }

  function failed(id: string, error: Error): void {
    if (stopping || controller.signal.aborted || unexpected) return;
    unexpected = new PreviewError('START_FAILED', `Service ${id} failed: ${failure(error).message}`);
    status(id, 'failed', error);
    controller.abort();
    notifyExit(unexpected);
  }

  function own(id: string, value: Resource): void {
    running.set(id, value);
    if (value.exited) void value.exited.then((error) => failed(id, error));
  }

  function environmentValue(value: EnvironmentValue): DatabaseBinding {
    if (typeof value === 'string' || 'fromEnv' in value) {
      const url = resolveInput(value, input.inputs);
      return { url, redactions: [url] };
    }
    if ('browserUrl' in value) return { url: browserUrl(value.browserUrl), redactions: [] };
    if ('publicUrl' in value) return { url: input.url, redactions: [] };
    const resolved = connections.get(value.service);
    if (!resolved) throw new PreviewError('START_FAILED', `Service ${value.service} has no ready connection.`);
    return resolved;
  }

  function start(id: string): Promise<void> {
    const existing = starts.get(id);
    if (existing) return existing;
    const operation = (async () => {
      await Promise.all(graph.get(id)!.map(start));
      assertRunning();
      const service = spec.services[id];
      await semaphore.run(async () => {
        assertRunning();
        status(id, 'starting');
        if (service.type === 'postgres' || service.type === 'redis') {
          const binding = input.databases[id];
          if (!binding) throw new PreviewError('START_FAILED', `Database ${id} is not available.`);
          connections.set(id, binding);
        } else if (service.type === 'external-postgres' || service.type === 'external-redis') {
          const url = resolveInput(service.url, input.inputs);
          await probeDatabase(service.type === 'external-postgres' ? 'postgres' : 'redis', url, {
            signal: controller.signal, timeoutMs: service.timeoutMs,
          });
          connections.set(id, { url, redactions: databaseRedactions(url) });
        } else {
          let native: NativeResource | undefined;
          if (service.type === 'static') {
            own(id, await startStatic(service.directory, service.spa, input.privateDirectory));
          } else if (service.type === 'attach') {
            const target = attachmentTarget(service.url);
            if (target.port === Number(port)) throw new PreviewError('INVALID_INPUT', 'An environment cannot attach to its own public listener.');
            // Native consumers need a numeric URL even when the external server requires a Host alias.
            const proxy = await createGateway({ onError: (error) => failed(id, error) });
            own(id, { target: { port: Number(new URL(proxy.url).port), hostHeader: new URL(proxy.url).host }, stop: () => proxy.close() });
            proxy.setTarget(target);
          } else {
            const env: Record<string, string> = {};
            const redactions: string[] = [];
            for (const [key, value] of Object.entries(service.env)) {
              const resolved = environmentValue(value);
              env[key] = resolved.url;
              redactions.push(...resolved.redactions);
            }
            native = await startNative({
              spec: { ...service, name: spec.name, env }, url: browserUrl(id), signal: controller.signal,
              appendLog: (text) => input.appendLog(`[${id}] ${text}`), redactions,
              onResource: (value) => own(id, value),
            });
          }
          assertRunning();
          const current = running.get(id)!;
          if (service.type !== 'static') {
            const ready = waitForHttp(current.target, service.readyPath, service.timeoutMs, controller.signal);
            await (current.exited ? Promise.race([ready, current.exited.then((error) => { throw error; })]) : ready);
            if (native) await native.verifyListener();
          }
          assertRunning();
          connections.set(id, { url: `http://127.0.0.1:${current.target.port}`, redactions: [] });
        }
        assertRunning();
        status(id, 'ready');
      });
    })().catch((error: unknown) => {
      if (!stopping && !controller.signal.aborted) {
        status(id, 'failed', error instanceof Error ? error : new Error('Service startup failed.'));
      }
      controller.abort();
      throw error;
    });
    starts.set(id, operation);
    return operation;
  }

  async function stop(): Promise<void> {
    if (stopWork) return stopWork;
    stopping = true;
    controller.abort();
    input.signal.removeEventListener('abort', onAbort);
    stopWork = (async () => {
      await Promise.allSettled([...starts.values()]);
      let incomplete = false;
      for (const id of reverseOrder(graph)) {
        const value = running.get(id);
        if (!value) continue;
        try {
          await value.stop();
          running.delete(id);
          const failed = failures.get(id);
          status(id, failed ? 'failed' : 'stopped', failed);
        } catch {
          incomplete = true;
          status(id, 'failed', new PreviewError('CLEANUP_INCOMPLETE', 'Owned service cleanup is incomplete.'));
        }
      }
      if (incomplete) throw new PreviewError('CLEANUP_INCOMPLETE', 'Some environment services could not be verified as stopped.');
    })();
    try { await stopWork; } finally { stopWork = undefined; }
  }

  try {
    await Promise.all([...graph.keys()].map(start));
    assertRunning();
    // Recheck native listeners after the last dependent becomes ready.
    for (const value of running.values()) {
      if ('verifyListener' in value && typeof value.verifyListener === 'function') await value.verifyListener();
    }
    assertRunning();
    return resource;
  } catch (error) {
    controller.abort();
    await Promise.allSettled([...starts.values()]);
    // The runtime retains this resource and any failed cleanup handle for retry.
    await stop();
    throw unexpected ?? error;
  }
}

function reverseOrder(graph: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  function visit(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dependency of graph.get(id)!) visit(dependency);
    order.push(id);
  }
  for (const id of graph.keys()) visit(id);
  return order.reverse();
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  async run(action: () => Promise<void>): Promise<void> {
    if (this.active >= limits.parallelServices) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try { await action(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
