import { setTimeout as delay } from 'node:timers/promises';
import type { NativeServiceSpec, ReadinessProbe, ServiceStatus } from './contracts.js';
import { PreviewError, failure, throwIfAborted } from './errors.js';
import { availablePort, runNativeJob, startNative, type NativeInput, type NativeResource } from './native.js';
import { nativePorts } from './spec.js';
import { waitForHttp, waitForTcp } from './readiness.js';
import type { Resource } from './resources.js';

export interface NativeService extends Resource {
  ports: Readonly<Record<string, number>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  verifyReady(): Promise<void>;
  verifyListener(port: number): Promise<void>;
}

/** One process owner for initial readiness, bounded restarts, probes and worker handoff. */
export async function startNativeService(input: Omit<NativeInput, 'spec' | 'onResource' | 'ownership'> & {
  spec: NativeServiceSpec;
  env: Record<string, string>;
  ownership?: () => NativeInput['ownership'];
  onResource(resource: NativeService): void;
  status(state: ServiceStatus['state'], error?: Error): void;
  probeBindings(probe: Extract<ReadinessProbe, { type: 'command' }>): { env: Record<string, string>; redactions: string[] };
}): Promise<NativeService> {
  const { spec } = input;
  const ports: Record<string, number> = {};
  for (const name of Object.keys(nativePorts(spec))) ports[name] = await availablePort();
  const env = input.env;
  const portEnvironment = Object.fromEntries(Object.entries(nativePorts(spec)).map(([name, key]) => [key, String(ports[name])]));
  const command = (argv: string[]) => argv.map(arg => arg.replace(/\{port(?::([a-z][a-z0-9-]*))?\}/g, (_, name: string | undefined) => {
    const value = ports[name ?? 'http'];
    if (!value) throw new PreviewError('INVALID_INPUT', `Command refers to undeclared port ${name ?? 'http'}.`);
    return String(value);
  }));
  const ready: ReadinessProbe = spec.ready ?? { type: 'http', port: 'http', path: spec.type === 'command' ? spec.readyPath : '/', timeoutMs: spec.type === 'command' ? spec.timeoutMs : 30000 };
  let current: NativeResource | undefined;
  const probes = new Set<Pick<Resource, 'stop'>>();
  let controller = new AbortController();
  let monitoring: Promise<void> | undefined;
  let stopWork: Promise<void> | undefined;
  let stopped = false;
  let paused = false;
  let restarts = 0;
  let terminal: Error | undefined;
  let restarting: Promise<void> | undefined;
  let notifyExit!: (error: Error) => void;
  const exited = new Promise<Error>(resolve => { notifyExit = resolve; });
  const target = { port: ports.http ?? 0, hostHeader: `127.0.0.1:${ports.http ?? 0}` };
  const resource: NativeService = {
    ports, target, exited, pause, resume,
    async verifyListener(port) {
      await restarting;
      if (terminal) throw terminal;
      if (!current || paused) throw new PreviewError('START_FAILED', 'The selected process is not running.');
      await current.verifyListener(port);
    },
    assertRunning() {
      if (terminal) throw terminal;
      throwIfAborted(input.signal);
    },
    async verifyReady() {
      await restarting;
      if (terminal) throw terminal;
      if (!paused) current?.assertRunning?.();
    },
    async stop() {
      stopped = true;
      await pause();
    },
  };
  input.onResource(resource);

  async function cleanup(): Promise<void> {
    // Retain each handle until cleanup succeeds; an incomplete stop can be retried.
    for (const probe of probes) { await probe.stop(); probes.delete(probe); }
    await current?.stop();
    current = undefined;
  }

  async function pause(): Promise<void> {
    if (stopWork) return stopWork;
    paused = true;
    controller.abort();
    stopWork = (async () => {
      await monitoring;
      await cleanup();
      input.status('stopped');
    })();
    try { await stopWork; } finally { stopWork = undefined; }
  }

  async function probe(definition: ReadinessProbe, signal: AbortSignal): Promise<void> {
    if (definition.type === 'http') {
      const port = ports[definition.port];
      await waitForHttp({ port, hostHeader: `127.0.0.1:${port}` }, definition.path, definition.timeoutMs, signal);
      await current!.verifyListener(port);
    } else if (definition.type === 'tcp') {
      await waitForTcp(ports[definition.port], definition.timeoutMs, signal);
      await current!.verifyListener(ports[definition.port]);
    } else {
      const bindings = input.probeBindings(definition);
      const deadline = Date.now() + definition.timeoutMs;
      while (true) {
        throwIfAborted(signal);
        let handle: Pick<Resource, 'stop'> | undefined;
        try {
          await runNativeJob({ ...input, signal, ownership: input.ownership?.(), portEnvironment,
            spec: { cwd: definition.cwd ?? spec.cwd, command: command(definition.command), env: bindings.env },
            redactions: [...(input.redactions ?? []), ...bindings.redactions],
            timeoutMs: Math.max(100, deadline - Date.now()),
            onResource: value => { handle = value; probes.add(value); },
          });
          if (handle) probes.delete(handle);
          return;
        } catch (error) {
          if (handle) { await handle.stop(); probes.delete(handle); }
          throwIfAborted(signal);
          if (Date.now() >= deadline) throw error;
          await delay(50, undefined, { signal });
        }
      }
    }
  }

  async function launch(): Promise<void> {
    const signal = AbortSignal.any([input.signal, controller.signal]);
    throwIfAborted(signal);
    input.status('starting');
    current = await startNative({ ...input, signal, ownership: input.ownership?.(), port: ports.http ?? 0, portEnvironment,
      spec: { cwd: spec.cwd, command: command(spec.command), env }, onResource: value => { current = value; },
    });
    const readiness = new AbortController();
    const checking = probe(ready, AbortSignal.any([signal, readiness.signal]));
    try {
      await Promise.race([
        checking,
        current.exited!.then(error => { throw error; }),
      ]);
      throwIfAborted(signal);
      current.assertRunning?.();
      if (spec.type === 'command') await current.verifyListener(ports.http);
      input.status('ready');
    } finally { readiness.abort(); await Promise.allSettled([checking]); }
  }

  async function retry(error: Error, failed = true): Promise<boolean> {
    await cleanup();
    const restart = spec.restart;
    if (paused || stopped || input.signal.aborted || !restart || restart.mode === 'never' ||
        restart.mode === 'on-failure' && !failed || restarts >= restart.maxRestarts) return false;
    restarts++;
    input.appendLog(`Restart ${restarts}/${restart.maxRestarts}: ${failure(error).message}\n`);
    await delay(restart.backoffMs, undefined, { signal: AbortSignal.any([input.signal, controller.signal]) });
    return true;
  }

  async function boot(): Promise<void> {
    while (true) {
      try { await launch(); return; }
      catch (error) {
        if (!await retry(error instanceof Error ? error : new Error('Process startup failed.'))) throw error;
      }
    }
  }

  async function watchLiveness(signal: AbortSignal): Promise<Error> {
    const live = spec.liveness!;
    let failures = 0;
    while (true) {
      await delay(live.intervalMs, undefined, { signal });
      try { await probe(live.probe, signal); failures = 0; }
      catch (error) {
        throwIfAborted(signal);
        if (++failures >= live.failureThreshold) return new PreviewError('START_FAILED', `Liveness failed ${failures} consecutive times: ${failure(error).message}`);
      }
    }
  }

  async function monitor(): Promise<void> {
    try {
      while (!paused && !stopped) {
        const checks = new AbortController();
        const signal = AbortSignal.any([input.signal, controller.signal, checks.signal]);
        let unsubscribe = () => {};
        const canceled = new Promise<never>((_, reject) => {
          const onAbort = () => reject(new PreviewError('CLOSED', 'Process supervision stopped.'));
          signal.addEventListener('abort', onAbort, { once: true });
          unsubscribe = () => signal.removeEventListener('abort', onAbort);
          if (signal.aborted) onAbort();
        });
        const live = spec.liveness ? watchLiveness(signal) : undefined;
        let outcome: { error: Error; failed: boolean };
        try {
          outcome = await Promise.race([
            current!.completion.then(result => ({ error: new PreviewError('START_FAILED', `Native command exited (${result.code ?? result.signal ?? 'unknown'}).`), failed: result.code !== 0 || !!result.signal })),
            current!.exited!.then(error => ({ error, failed: true })),
            ...(live ? [live.then(error => ({ error, failed: true }))] : []),
            canceled,
          ]);
        } finally {
          checks.abort(); unsubscribe();
          if (live) await Promise.allSettled([live]);
        }
        restarting = (async () => {
          if (!await retry(outcome.error, outcome.failed)) throw outcome.error;
          await boot();
        })();
        try { await restarting; } finally { restarting = undefined; }
      }
    } catch (error) {
      if (paused || stopped || input.signal.aborted) return;
      terminal = error instanceof Error ? error : new Error('Process supervision failed.');
      input.status('failed', terminal);
      notifyExit(terminal);
    }
  }

  async function resume(): Promise<void> {
    if (stopped) throw new PreviewError('CLOSED', 'The process owner is stopped.');
    if (!paused) return;
    controller = new AbortController(); paused = false; terminal = undefined;
    await boot();
    monitoring = monitor();
  }

  try {
    await boot();
    monitoring = monitor();
    return resource;
  } catch (error) { await resource.stop(); throw error; }
}
