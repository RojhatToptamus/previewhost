import { randomUUID } from 'node:crypto';
import {
  limits, nameSchema, requestSchemas, type AttemptResult, type AttemptSummary, type EffectiveSpec, type Failure,
  type LogResult, type PreviewApi, type PreviewSpec, type PreviewStatus, type RuntimeOptions, type WaitOptions, type StopOptions, type SecretSetupContext,
} from './contracts.js';
import { PreviewError, failure, throwIfAborted } from './errors.js';
import { attachmentTarget, canonicalDirectory, describeSpec, normalizeSpec, parseSpec, resolveInput, sameSources, validateResolvedInputs } from './spec.js';
import { createGateway, type Gateway } from './gateway.js';
import { startStatic } from './static.js';
import { startNative } from './native.js';
import { waitForHttp } from './readiness.js';
import type { Resource } from './resources.js';
import { startEnvironment } from './environment.js';
import { createDataOwner, type DataOwner } from './data.js';
import { requireSelected, resolveSecrets, secretRequirements, validateSecretId } from './secrets.js';

interface Attempt {
  summary: AttemptSummary;
  controller: AbortController;
  completed: boolean;
  waiters: Set<() => void>;
  resource?: Resource;
  log: Buffer;
  truncated: boolean;
  cleanupTask?: Promise<void>;
  nodes: number;
  failure?: Failure;
}
interface Slot {
  name: string;
  gateway?: Gateway;
  active?: Attempt;
  candidate?: Attempt;
  latest?: Attempt;
  operation?: Promise<void>;
  stopping?: Promise<void>;
  cleanup: Set<Attempt>;
  control?: AbortController;
}

export interface PreviewRuntime extends PreviewApi {
  /** Excludes an owner's private directory from current and future static previews. */
  protectDirectory(directory: string): Promise<void>;
  /** Validates and authorizes a private form without reading values or starting code. */
  prepareSecretSetup(input: PreviewSpec | string, signal: AbortSignal): Promise<SecretSetupContext>;
  close(): Promise<void>;
}

export async function createPreviewRuntime(options: RuntimeOptions): Promise<PreviewRuntime> {
  if (!options || !Array.isArray(options.allowedRoots) || options.allowedRoots.length < 1 || options.allowedRoots.length > 32) {
    throw new PreviewError('INVALID_INPUT', 'Supply between 1 and 32 allowed source roots.');
  }
  const roots = [...new Set(await Promise.all(options.allowedRoots.map(canonicalDirectory)))];
  const inputs = { ...options.inputs };
  if (options.secretIds !== undefined && (!Array.isArray(options.secretIds) || options.secretIds.length > limits.secrets)) {
    throw new PreviewError('INVALID_INPUT', `Select at most ${limits.secrets} secret names.`);
  }
  for (const id of options.secretIds ?? []) validateSecretId(id);
  const secretIds = new Set(options.secretIds ?? []);
  if (Object.keys(inputs).length > 128 || Object.entries(inputs).some(([key, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) {
    throw new PreviewError('INVALID_INPUT', 'Owner inputs must be at most 128 named strings of at most 4096 characters.');
  }
  if (options.dockerSocket && !options.dataDirectory) throw new PreviewError('INVALID_INPUT', 'dockerSocket requires a dataDirectory.');
  const data = options.dataDirectory ? await createDataOwner({ directory: options.dataDirectory, dockerSocket: options.dockerSocket }) : undefined;
  return new Runtime(roots, options.authorize, inputs, secretIds, data);
}

class Runtime implements PreviewRuntime {
  private readonly slots = new Map<string, Slot>();
  private readonly privateDirectories = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly roots: string[], private readonly authorize: RuntimeOptions['authorize'],
    private readonly inputs: Readonly<Record<string, string>>, private readonly secretIds: ReadonlySet<string>, private readonly data?: DataOwner,
  ) {
    if (data) this.privateDirectories.add(data.directory);
    for (const name of data?.names() ?? []) this.slots.set(name, { name, cleanup: new Set() });
  }

  async protectDirectory(directory: string): Promise<void> {
    this.assertOpen();
    const canonical = await canonicalDirectory(directory);
    this.assertOpen();
    if (!this.privateDirectories.has(canonical) && this.privateDirectories.size >= 32) {
      throw new PreviewError('INVALID_INPUT', 'At most 32 private directories can be protected.');
    }
    this.privateDirectories.add(canonical);
  }

  async inspect(input: PreviewSpec) {
    this.assertOpen();
    const spec = await normalizeSpec(parseSpec(input), this.roots, this.inputs, this.privateDirectories);
    this.assertOpen();
    const secrets = secretRequirements(spec, this.secretIds);
    return { ...describeSpec(spec), ...(secrets.length ? { secrets } : {}) };
  }

  async prepareSecretSetup(input: PreviewSpec | string, signal: AbortSignal): Promise<SecretSetupContext> {
    this.assertOpen();
    throwIfAborted(signal);
    const mode = typeof input === 'string' ? 'edit' : 'missing';
    if (typeof input === 'string') validateSecretId(input);
    const spec = typeof input === 'string' ? undefined : await abortable(normalizeSpec(parseSpec(input), this.roots, this.inputs, this.privateDirectories), signal);
    const requirements = spec ? secretRequirements(spec, this.secretIds) : [{ id: input as string, selected: this.secretIds.has(input as string), bindings: [] }];
    requireSelected(requirements);
    if (!this.authorize || !await abortable(Promise.resolve(this.authorize({ operation: 'secrets-setup', mode,
      ids: requirements.map((item) => item.id), ...(spec ? { spec: structuredClone(spec) } : {}), signal })), signal)) {
      throw new PreviewError('EXECUTION_DENIED', 'The owner did not authorize this private secret form.');
    }
    this.assertOpen();
    if (spec) {
      const checked = await abortable(normalizeSpec(spec, this.roots, this.inputs, this.privateDirectories), signal);
      if (!sameSources(spec, checked)) throw new PreviewError('SOURCE_DENIED', 'The source directory changed during authorization.');
    }
    throwIfAborted(signal);
    const sources = spec?.type === 'command' ? [spec.cwd] : spec?.type === 'static' ? [spec.directory] : spec?.type === 'environment'
      ? Object.values(spec.services).flatMap((service) => service.type === 'command' ? [service.cwd] : service.type === 'static' ? [service.directory] : []) : [];
    return { mode, ...(spec ? { name: spec.name } : {}), sources: [...new Set(sources)].sort(), requirements };
  }

  async start(input: PreviewSpec): Promise<PreviewStatus> {
    this.assertOpen();
    const spec = parseSpec(input);
    const previous = this.slots.get(spec.name);
    if (previous?.operation || previous?.stopping) throw new PreviewError('BUSY', 'This preview already has an operation in progress.');
    if (previous?.cleanup.size || previous?.gateway && !previous.active) throw new PreviewError('CLEANUP_INCOMPLETE', 'Retry stop to resolve the remaining cleanup before starting this name.');
    if (previous?.active) throw new PreviewError('ALREADY_EXISTS', 'This name is active. Use replace to start a candidate.');
    if (this.data?.status(spec.name)?.cleanup) throw new PreviewError('CLEANUP_INCOMPLETE', 'Resolve retained database cleanup with stop before starting this name.');
    if ([...this.slots.values()].filter(isLive).length >= limits.livePreviews) {
      throw new PreviewError('BUSY', `At most ${limits.livePreviews} previews can be active or awaiting cleanup.`);
    }
    this.checkNodeCapacity(spec);
    const slot: Slot = { name: spec.name, cleanup: new Set() };
    this.slots.delete(spec.name);
    this.slots.set(spec.name, slot);
    return this.begin(slot, spec, 'start');
  }

  async replace(name: string, input: PreviewSpec): Promise<PreviewStatus> {
    this.assertOpen();
    const slot = this.slot(name);
    const spec = parseSpec(input);
    if (spec.name !== name) throw new PreviewError('INVALID_INPUT', 'The replacement spec must use the same preview name.');
    if (slot.operation || slot.stopping) throw new PreviewError('BUSY', 'This preview already has an operation in progress.');
    if (slot.cleanup.size) throw new PreviewError('CLEANUP_INCOMPLETE', 'Resolve remaining cleanup with stop before replacing this preview.');
    if (!slot.active) throw new PreviewError('NOT_FOUND', 'This preview has no active target. Use start.');
    if ((slot.active.summary.type === 'environment') !== (spec.type === 'environment')) {
      throw new PreviewError('INVALID_INPUT', 'Stop before changing between an environment and a single preview.');
    }
    this.checkNodeCapacity(spec);
    return this.begin(slot, spec, 'replace');
  }

  async list(): Promise<PreviewStatus[]> { return [...this.slots.values()].map((slot) => this.status(slot)); }
  async get(name: string): Promise<PreviewStatus> { return this.status(this.slot(name)); }

  async wait(name: string, attemptId: string, options: WaitOptions = {}): Promise<AttemptResult> {
    const slot = this.slot(name, 'ATTEMPT_EXPIRED');
    const attempt = this.attempt(slot, attemptId);
    const timeoutMs = options.timeoutMs ?? limits.waitMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.waitMs) {
      throw new PreviewError('INVALID_INPUT', `Wait timeout must be between 1 and ${limits.waitMs} milliseconds.`);
    }
    await waitBounded(attempt, timeoutMs, options.signal);
    return { ...copySummary(attempt.summary), name, ...(slot.active === attempt && slot.gateway ? { url: slot.gateway.url } : {}) };
  }

  async logs(name: string, attemptId?: string, maxBytes = limits.logBytes): Promise<LogResult> {
    const slot = this.slot(name, 'ATTEMPT_EXPIRED');
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > limits.logBytes) throw new PreviewError('INVALID_INPUT', 'Log size is outside the supported range.');
    const attempt = attemptId ? this.attempt(slot, attemptId) : slot.candidate ?? slot.active ?? slot.latest;
    if (!attempt) throw new PreviewError('ATTEMPT_EXPIRED', 'The attempt logs are no longer available.');
    return {
      name, attemptId: attempt.summary.id,
      text: attempt.log.subarray(Math.max(0, attempt.log.length - maxBytes)).toString('utf8'),
      truncated: attempt.truncated || attempt.log.length > maxBytes,
    };
  }

  async cancel(name: string, attemptId: string): Promise<PreviewStatus> {
    const slot = this.slot(name);
    if (!slot.candidate || slot.candidate.summary.id !== attemptId) {
      throw new PreviewError('STALE_ATTEMPT', 'This attempt is no longer the pending candidate.');
    }
    slot.candidate.controller.abort();
    await slot.operation;
    return this.status(slot);
  }

  async stop(name: string, options: StopOptions = {}): Promise<PreviewStatus> {
    if (!requestSchemas.stop.safeParse({ ...options, name }).success) throw new PreviewError('INVALID_INPUT', 'Invalid stop options.');
    const slot = this.slot(name);
    if (options.afterEngineRestart && (slot.active || slot.candidate || slot.operation || slot.stopping)) {
      throw new PreviewError('BUSY', 'Engine-restart recovery requires a stopped environment with no operation in progress.');
    }
    slot.control?.abort();
    if (slot.stopping) { await slot.stopping; return this.status(slot); }
    slot.candidate?.controller.abort();
    slot.active?.controller.abort();
    slot.gateway?.setTarget(undefined);
    const controller = options.afterEngineRestart ? new AbortController() : undefined;
    if (controller) slot.control = controller;
    const stopping = Promise.resolve().then(async () => {
      if (controller) {
        await this.authorizeData('recover-data', slot, controller.signal);
      }
      await this.stopSlot(slot, options);
    });
    slot.stopping = stopping;
    try { await stopping; } finally { slot.stopping = undefined; slot.control = undefined; this.prune(); }
    return this.status(slot);
  }

  async deleteData(name: string): Promise<PreviewStatus> {
    this.assertOpen();
    const slot = this.slot(name);
    if (isLive(slot)) throw new PreviewError('BUSY', 'Stop the environment and resolve application cleanup before deleting data.');
    if (!this.data?.status(name)) throw new PreviewError('NOT_FOUND', 'This name has no retained database data.');
    const cleanup = this.data.status(name)?.cleanup;
    if (cleanup && cleanup.operation !== 'remove-credential') throw new PreviewError('CLEANUP_INCOMPLETE', 'Resolve retained cleanup with stop before deleting data.');
    const controller = new AbortController();
    slot.control = controller;
    const operation = Promise.resolve().then(async () => {
      await this.authorizeData('delete-data', slot, controller.signal);
      throwIfAborted(controller.signal);
      this.assertOpen();
      await this.data!.deleteData(name);
    });
    slot.operation = operation;
    try { await operation; }
    finally { if (slot.operation === operation) slot.operation = undefined; slot.control = undefined; this.prune(); }
    return this.status(slot);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.slots.keys()].map((name) => this.stop(name)));
      if (results.some((result) => result.status === 'rejected')) {
        throw new PreviewError('CLEANUP_INCOMPLETE', 'Some preview resources could not be verified as stopped. Inspect status and retry stop.');
      }
      await this.data?.close();
    })();
    try { await this.closing; }
    catch (error) { this.closing = undefined; throw error; }
  }

  private begin(slot: Slot, spec: EffectiveSpec, operation: 'start' | 'replace'): PreviewStatus {
    const attempt: Attempt = {
      summary: { id: randomUUID(), type: spec.type, state: 'starting', startedAt: new Date().toISOString() },
      controller: new AbortController(), completed: false, waiters: new Set(),
      log: Buffer.alloc(0), truncated: false, nodes: nodeCost(spec),
    };
    slot.candidate = attempt;
    slot.operation = this.runCandidate(slot, attempt, spec, operation).finally(() => {
      slot.operation = undefined;
      attempt.completed = true;
      for (const waiter of attempt.waiters) waiter();
      attempt.waiters.clear();
      this.prune();
    });
    return this.status(slot);
  }

  private async runCandidate(slot: Slot, attempt: Attempt, input: EffectiveSpec, operation: 'start' | 'replace'): Promise<void> {
    const signal = attempt.controller.signal;
    let committed = false;
    let timedOut = false;
    let secrets: Record<string, string> = {};
    const deadline = input.type === 'environment' ? setTimeout(() => {
      timedOut = true; attempt.controller.abort();
    }, input.timeoutMs) : undefined;
    try {
      const spec = await abortable(normalizeSpec(input, this.roots, this.inputs, this.privateDirectories), signal);
      this.admitted(slot, attempt);
      if (this.authorize) {
        const approved = await abortable(Promise.resolve(this.authorize({ operation, spec: structuredClone(spec), signal })), signal);
        if (!approved) throw new PreviewError('EXECUTION_DENIED', 'The host denied this preview operation.');
      } else if (needsExecution(spec)) {
        throw new PreviewError('EXECUTION_DENIED', 'Commands and managed databases require host authorization. Start the daemon with --allow-exec only for trusted code.');
      }
      this.admitted(slot, attempt);
      // Recheck the selected directory after approval; never silently switch to a new symlink target.
      const checked = await abortable(normalizeSpec(spec, this.roots, this.inputs, this.privateDirectories), signal);
      if (!sameSources(spec, checked)) {
        throw new PreviewError('SOURCE_DENIED', 'The source directory changed during authorization.');
      }
      this.admitted(slot, attempt);
      secrets = await resolveSecrets(secretRequirements(spec, this.secretIds), signal);
      validateResolvedInputs(spec, this.inputs, secrets);
      this.admitted(slot, attempt);
      if (!slot.gateway) {
        slot.gateway = await createGateway({ onError: (error) => this.gatewayFailed(slot, error) });
      }
      this.admitted(slot, attempt);
      let verifyListener: (() => Promise<void>) | undefined;
      if (spec.type === 'static') {
        attempt.resource = await startStatic(spec.directory, spec.spa, this.privateDirectories);
      } else if (spec.type === 'attach') {
        const target = attachmentTarget(spec.url);
        if (target.port === Number(new URL(slot.gateway.url).port)) throw new PreviewError('INVALID_INPUT', 'A preview cannot attach to its own public listener.');
        attempt.resource = { target, stop: async () => {} };
      } else if (spec.type === 'command') {
        const resource = await startNative({
          spec: { ...spec, env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, resolveInput(value, this.inputs, secrets)])) },
          url: slot.gateway.url, signal,
          appendLog: (text) => appendLog(attempt, text),
          onResource: (resource) => { attempt.resource = resource; },
        });
        attempt.resource = resource;
        verifyListener = () => resource.verifyListener();
      } else {
        const databases = Object.fromEntries(Object.entries(spec.services).filter((entry) => entry[1].type === 'postgres' || entry[1].type === 'redis')) as
          Record<string, Extract<(typeof spec.services)[string], { type: 'postgres' | 'redis' }>>;
        if (Object.keys(databases).length && !this.data) throw new PreviewError('INVALID_INPUT', 'Managed databases require a private dataDirectory (--data-dir for the daemon).');
        const bindings = this.data && (Object.keys(databases).length || this.data.status(slot.name))
          ? await this.data.open(slot.name, databases, { signal, onFailure: (error) => this.environmentFailed(slot, error) }) : {};
        this.admitted(slot, attempt);
        attempt.summary.services = {};
        attempt.resource = await startEnvironment({
          spec, url: slot.gateway.url, inputs: this.inputs, secrets, databases: bindings, signal, privateDirectories: this.privateDirectories,
          appendLog: (text) => appendLog(attempt, text),
          serviceStatus: (id, status) => { attempt.summary.services![id] = status; },
          onResource: (resource) => { attempt.resource = resource; },
        });
      }
      this.admitted(slot, attempt);
      const resource = attempt.resource;
      if (!resource) throw new Error('Preview resource was not created.');
      if (spec.type === 'command' || spec.type === 'attach') {
        const readiness = waitForHttp(resource.target, spec.readyPath, spec.timeoutMs, signal);
        await (resource.exited ? Promise.race([readiness, resource.exited.then((error) => { throw error; })]) : readiness);
        this.admitted(slot, attempt);
        if (verifyListener) await verifyListener();
      }
      this.admitted(slot, attempt);
      resource.assertRunning?.();
      const old = slot.active;
      slot.gateway.setRoutes(resource.routes ?? { '127.0.0.1': resource.target });
      slot.active = attempt;
      slot.candidate = undefined;
      slot.latest = attempt;
      attempt.summary.state = 'ready';
      attempt.summary.readyAt = new Date().toISOString();
      committed = true;
      clearTimeout(deadline);
      if (resource.exited) void resource.exited.then((error) => this.resourceFailed(slot, attempt, error));
      if (old?.resource) {
        slot.cleanup.add(old);
        await Promise.all([...new Set(Object.values(old.resource.routes ?? { primary: old.resource.target }))].map((target) => slot.gateway!.drain(target)));
        await this.cleanupAttempt(slot, old);
      }
    } catch (error) {
      if (!committed) {
        const canceled = signal.aborted && !timedOut && !attempt.failure;
        attempt.controller.abort();
        attempt.summary.state = canceled ? 'canceled' : 'failed';
        if (attempt.summary.state !== 'canceled') attempt.summary.error = attempt.failure ?? (timedOut
          ? { code: 'TIMEOUT', message: 'The environment startup deadline expired.' } : redactedFailure(error, input, this.inputs, secrets));
        slot.latest = attempt;
        await this.cleanupAttempt(slot, attempt).catch(() => {});
      } else {
        // The new route remains active when retiring the old resource fails.
        attempt.summary.state = 'cleanup-incomplete';
        attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
      }
    } finally {
      clearTimeout(deadline);
      if (slot.candidate === attempt) slot.candidate = undefined;
      if (!slot.active && slot.gateway) {
        await this.closeGateway(slot).catch((error) => {
          attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
          attempt.summary.state = 'cleanup-incomplete';
        });
      }
      if (!slot.active && !slot.cleanup.size && this.data?.status(slot.name)) {
        await this.stopData(slot, [attempt]).catch((error) => {
          attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
          attempt.summary.state = 'cleanup-incomplete';
        });
      }
    }
  }

  private async cleanupAttempt(slot: Slot, attempt: Attempt): Promise<void> {
    if (attempt.cleanupTask) return attempt.cleanupTask;
    if (!attempt.resource) return;
    slot.cleanup.add(attempt);
    attempt.cleanupTask = (async () => {
      try {
        await attempt.resource!.stop();
        attempt.resource = undefined;
        slot.cleanup.delete(attempt);
        if (attempt.summary.state === 'ready' || attempt.summary.state === 'cleanup-incomplete') {
          attempt.summary.state = 'stopped';
          delete attempt.summary.error;
        }
      } catch (error) {
        attempt.summary.state = 'cleanup-incomplete';
        attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
        throw new PreviewError('CLEANUP_INCOMPLETE', attempt.summary.error.message);
      }
    })();
    try { await attempt.cleanupTask; } finally { attempt.cleanupTask = undefined; }
  }

  private async stopSlot(slot: Slot, options?: StopOptions): Promise<void> {
    await slot.operation?.catch(() => {});
    const attempts = new Set([...slot.cleanup, ...[slot.active, slot.candidate, slot.latest].filter((value): value is Attempt => !!value)]);
    await Promise.allSettled([...attempts].map((attempt) => this.cleanupAttempt(slot, attempt)));
    slot.active = undefined;
    slot.candidate = undefined;
    await this.closeGateway(slot);
    if (slot.cleanup.size) throw new PreviewError('CLEANUP_INCOMPLETE', 'Some owned resources could not be verified as stopped. The cleanup handles remain available for retry.');
    await this.stopData(slot, attempts, options);
  }

  private async stopData(slot: Slot, attempts: Iterable<Attempt>, options?: StopOptions): Promise<void> {
    await this.data?.stop(slot.name, options);
    for (const attempt of attempts) {
      for (const service of Object.values(attempt.summary.services ?? {})) {
        if ((service.type === 'postgres' || service.type === 'redis') && service.state !== 'failed') service.state = 'stopped';
      }
    }
  }

  private async resourceFailed(slot: Slot, attempt: Attempt, error: Error): Promise<void> {
    if (slot.active !== attempt || slot.stopping) return;
    if (attempt.summary.type === 'environment') { this.environmentFailed(slot, error); return; }
    slot.gateway?.setTarget(undefined);
    slot.active = undefined;
    slot.latest = attempt;
    attempt.summary.state = 'failed';
    attempt.summary.error = failure(error);
    await this.cleanupAttempt(slot, attempt).catch(() => {});
    if (!slot.active && !slot.candidate && !slot.operation && slot.gateway) {
      await this.closeGateway(slot).catch(() => {});
    }
    this.prune();
  }

  private environmentFailed(slot: Slot, error: Error): void {
    if (slot.stopping) return;
    const info = failure(error);
    if (slot.active) {
      slot.active.summary.state = 'failed'; slot.active.summary.error = info;
    }
    if (slot.candidate) slot.candidate.failure = info;
    slot.gateway?.setTarget(undefined);
    // stop joins candidate acquisition, then app cleanup, then the slot's databases.
    void this.stop(slot.name).catch(() => {});
  }

  private async authorizeData(operation: 'delete-data' | 'recover-data', slot: Slot, signal: AbortSignal): Promise<void> {
    // Cleanup remains available after a failed close, while this owner retains its lock.
    if (operation === 'delete-data') this.assertOpen();
    const data = this.data?.status(slot.name);
    if (!data) throw new PreviewError('NOT_FOUND', 'This name has no retained database data.');
    if (!this.authorize || !await abortable(Promise.resolve(this.authorize({ operation, name: slot.name, resources: data.resources, signal })), signal)) {
      throw new PreviewError('EXECUTION_DENIED', 'The host did not authorize this persistent data operation.');
    }
    if (operation === 'delete-data') this.assertOpen();
    throwIfAborted(signal);
  }

  private checkNodeCapacity(spec: EffectiveSpec): void {
    let reserved = 0;
    for (const slot of this.slots.values()) {
      const attempts = new Set([slot.active, slot.candidate, ...slot.cleanup]);
      for (const attempt of attempts) if (attempt && (attempt.resource || attempt.summary.state === 'starting')) reserved += attempt.nodes;
      const data = this.data?.status(slot.name);
      if (!slot.active && !slot.candidate && (data?.running || data?.cleanup && data.cleanup.operation !== 'remove-credential')) reserved += data.resources.length;
    }
    if (reserved + nodeCost(spec) > limits.liveNodes) throw new PreviewError('BUSY', `At most ${limits.liveNodes} service slots can be active, starting, or awaiting cleanup.`);
  }

  private async closeGateway(slot: Slot): Promise<void> {
    if (!slot.gateway) return;
    try {
      await slot.gateway.close();
      slot.gateway = undefined;
    } catch (error) {
      if (slot.latest) {
        slot.latest.summary.state = 'cleanup-incomplete';
        slot.latest.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
      }
      throw new PreviewError('CLEANUP_INCOMPLETE', 'The public listener could not be verified as closed. Retry stop.');
    }
  }

  private gatewayFailed(slot: Slot, error: Error): void {
    slot.candidate?.controller.abort();
    if (slot.active) void this.resourceFailed(slot, slot.active, error);
  }
  private admitted(slot: Slot, attempt: Attempt): void {
    throwIfAborted(attempt.controller.signal);
    if (this.closed || slot.stopping || slot.candidate !== attempt) throw new PreviewError('CLOSED', 'This preview operation is no longer active.');
  }
  private status(slot: Slot): PreviewStatus {
    const data = this.data?.status(slot.name);
    return {
      name: slot.name, ...(slot.gateway ? { url: slot.gateway.url } : {}),
      ...(slot.active ? { active: copySummary(slot.active.summary) } : {}),
      ...(slot.candidate ? { candidate: copySummary(slot.candidate.summary) } : {}),
      ...(slot.latest ? { latest: copySummary(slot.latest.summary) } : {}),
      busy: !!slot.operation || !!slot.stopping,
      ...(slot.cleanup.size ? { cleanup: [...slot.cleanup].filter((attempt) => attempt.summary.state === 'cleanup-incomplete').map((attempt) => ({ attemptId: attempt.summary.id, error: attempt.summary.error! })) } : {}),
      ...(data ? { data } : {}),
    };
  }
  private assertOpen(): void { if (this.closed) throw new PreviewError('CLOSED', 'This runtime is closed.'); }
  private slot(name: string, missingCode: 'NOT_FOUND' | 'ATTEMPT_EXPIRED' = 'NOT_FOUND'): Slot {
    if (!nameSchema.safeParse(name).success) throw new PreviewError('INVALID_INPUT', 'Invalid preview name.');
    let slot = this.slots.get(name);
    if (!slot && this.data?.status(name)) {
      slot = { name, cleanup: new Set() }; this.slots.set(name, slot);
    }
    if (!slot) throw new PreviewError(missingCode, 'This preview or attempt is not available in the bounded runtime history.');
    return slot;
  }
  private attempt(slot: Slot, id: string): Attempt {
    const attempt = [slot.active, slot.candidate, slot.latest, ...slot.cleanup].find((value) => value?.summary.id === id);
    if (!attempt) throw new PreviewError('ATTEMPT_EXPIRED', 'The attempt is unknown or its bounded history expired.');
    return attempt;
  }
  private prune(): void {
    const terminal = [...this.slots.values()].filter((slot) => !isLive(slot) && !this.data?.status(slot.name));
    for (const slot of terminal.slice(0, Math.max(0, terminal.length - limits.terminalRecords))) this.slots.delete(slot.name);
  }
}

function isLive(slot: Slot): boolean { return !!(slot.active || slot.candidate || slot.operation || slot.stopping || slot.gateway || slot.cleanup.size); }
function copySummary(summary: AttemptSummary): AttemptSummary { return structuredClone(summary); }
function nodeCost(spec: EffectiveSpec): number { return spec.type === 'environment' ? Object.keys(spec.services).length : 1; }
function needsExecution(spec: EffectiveSpec): boolean {
  return spec.type === 'command' || spec.type === 'environment' && Object.values(spec.services).some((service) =>
    service.type === 'command' || service.type === 'postgres' || service.type === 'redis');
}
function appendLog(attempt: Attempt, text: string): void {
  const bytes = Buffer.from(text);
  const combined = Buffer.concat([attempt.log, bytes]);
  attempt.truncated ||= combined.length > limits.logBytes;
  attempt.log = combined.subarray(Math.max(0, combined.length - limits.logBytes));
}
function redactedFailure(error: unknown, spec: EffectiveSpec, inputs: Readonly<Record<string, string>> = {}, secrets: Readonly<Record<string, string>> = {}) {
  const result = failure(error);
  const values = spec.type === 'command' ? Object.values(spec.env).filter((value): value is string => typeof value === 'string') : spec.type === 'environment'
    ? Object.values(spec.services).flatMap((service) => service.type === 'command' ? Object.values(service.env).filter((value): value is string => typeof value === 'string') :
      (service.type === 'external-postgres' || service.type === 'external-redis') && typeof service.url === 'string' ? [service.url] : []) : [];
    for (const value of [...values, ...Object.values(inputs), ...Object.values(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
      const utf8 = Buffer.from(value).toString('utf8');
      result.message = result.message.replaceAll(value, '[redacted]').replaceAll(utf8, '[redacted]').replaceAll(encodeURIComponent(utf8), '[redacted]');
    }
  return result;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new PreviewError('CLOSED', 'The operation was canceled.')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function waitBounded(attempt: Attempt, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new PreviewError('CLOSED', 'The wait was canceled.'));
  if (attempt.completed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); attempt.waiters.delete(onComplete); };
    const timer = setTimeout(() => { cleanup(); reject(new PreviewError('TIMEOUT', 'The attempt is still pending. Inspect status or wait again.')); }, timeoutMs);
    const onAbort = () => { cleanup(); reject(new PreviewError('CLOSED', 'The wait was canceled.')); };
    const onComplete = () => { cleanup(); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    attempt.waiters.add(onComplete);
  });
}
