import { randomUUID } from 'node:crypto';
import {
  limits, nameSchema, type AttemptResult, type AttemptSummary, type EffectiveSpec,
  type LogResult, type PreviewApi, type PreviewSpec, type PreviewStatus, type RuntimeOptions, type WaitOptions,
} from './contracts.js';
import { PreviewError, failure, throwIfAborted } from './errors.js';
import { attachmentTarget, canonicalDirectory, describeSpec, normalizeSpec, parseSpec } from './spec.js';
import { createGateway, type Gateway } from './gateway.js';
import { startStatic } from './static.js';
import { startNative } from './native.js';
import { waitForHttp } from './readiness.js';
import type { Resource } from './resources.js';

interface Attempt {
  summary: AttemptSummary;
  controller: AbortController;
  completed: boolean;
  waiters: Set<() => void>;
  resource?: Resource;
  log: Buffer;
  truncated: boolean;
  cleanupTask?: Promise<void>;
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
}

export interface PreviewRuntime extends PreviewApi { close(): Promise<void> }

export async function createPreviewRuntime(options: RuntimeOptions): Promise<PreviewRuntime> {
  if (!options || !Array.isArray(options.allowedRoots) || options.allowedRoots.length < 1 || options.allowedRoots.length > 32) {
    throw new PreviewError('INVALID_INPUT', 'Supply between 1 and 32 allowed source roots.');
  }
  const roots = [...new Set(await Promise.all(options.allowedRoots.map(canonicalDirectory)))];
  return new Runtime(roots, options.authorize);
}

class Runtime implements PreviewRuntime {
  private readonly slots = new Map<string, Slot>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly roots: string[], private readonly authorize: RuntimeOptions['authorize']) {}

  async inspect(input: PreviewSpec) {
    this.assertOpen();
    const spec = await normalizeSpec(parseSpec(input), this.roots);
    this.assertOpen();
    return describeSpec(spec);
  }

  async start(input: PreviewSpec): Promise<PreviewStatus> {
    this.assertOpen();
    const spec = parseSpec(input);
    const previous = this.slots.get(spec.name);
    if (previous?.operation || previous?.stopping) throw new PreviewError('BUSY', 'This preview already has an operation in progress.');
    if (previous?.cleanup.size || previous?.gateway && !previous.active) throw new PreviewError('CLEANUP_INCOMPLETE', 'Retry stop to resolve the remaining cleanup before starting this name.');
    if (previous?.active) throw new PreviewError('ALREADY_EXISTS', 'This name is active. Use replace to start a candidate.');
    if ([...this.slots.values()].filter(isLive).length >= limits.livePreviews) {
      throw new PreviewError('BUSY', `At most ${limits.livePreviews} previews can be active or awaiting cleanup.`);
    }
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

  async stop(name: string): Promise<PreviewStatus> {
    const slot = this.slot(name);
    if (slot.stopping) { await slot.stopping; return this.status(slot); }
    slot.candidate?.controller.abort();
    slot.active?.controller.abort();
    slot.gateway?.setTarget(undefined);
    const stopping = this.stopSlot(slot);
    slot.stopping = stopping;
    try { await stopping; } finally { slot.stopping = undefined; this.prune(); }
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
    })();
    try { await this.closing; } finally { this.closing = undefined; }
  }

  private begin(slot: Slot, spec: EffectiveSpec, operation: 'start' | 'replace'): PreviewStatus {
    const attempt: Attempt = {
      summary: { id: randomUUID(), type: spec.type, state: 'starting', startedAt: new Date().toISOString() },
      controller: new AbortController(), completed: false, waiters: new Set(),
      log: Buffer.alloc(0), truncated: false,
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
    try {
      const spec = await abortable(normalizeSpec(input, this.roots), signal);
      this.admitted(slot, attempt);
      if (this.authorize) {
        const approved = await abortable(Promise.resolve(this.authorize({ operation, spec: structuredClone(spec), signal })), signal);
        if (!approved) throw new PreviewError('EXECUTION_DENIED', 'The host denied this preview operation.');
      } else if (spec.type === 'command') {
        throw new PreviewError('EXECUTION_DENIED', 'Native execution requires host authorization. Start the daemon with --allow-exec only for trusted code.');
      }
      this.admitted(slot, attempt);
      // Recheck the selected directory after approval; never silently switch to a new symlink target.
      const checked = await abortable(normalizeSpec(spec, this.roots), signal);
      if ((spec.type === 'command' && checked.type === 'command' && spec.cwd !== checked.cwd) ||
          (spec.type === 'static' && checked.type === 'static' && spec.directory !== checked.directory)) {
        throw new PreviewError('SOURCE_DENIED', 'The source directory changed during authorization.');
      }
      this.admitted(slot, attempt);
      if (!slot.gateway) {
        slot.gateway = await createGateway({ onError: (error) => this.gatewayFailed(slot, error) });
      }
      this.admitted(slot, attempt);
      let verifyListener: (() => Promise<void>) | undefined;
      if (spec.type === 'static') {
        attempt.resource = await startStatic(spec.directory, spec.spa);
      } else if (spec.type === 'attach') {
        const target = attachmentTarget(spec.url);
        if (target.port === Number(new URL(slot.gateway.url).port)) throw new PreviewError('INVALID_INPUT', 'A preview cannot attach to its own public listener.');
        attempt.resource = { target, stop: async () => {} };
      } else {
        const resource = await startNative({
          spec, url: slot.gateway.url, signal,
          appendLog: (text) => appendLog(attempt, text),
          onResource: (resource) => { attempt.resource = resource; },
        });
        attempt.resource = resource;
        verifyListener = () => resource.verifyListener();
      }
      this.admitted(slot, attempt);
      const resource = attempt.resource;
      if (!resource) throw new Error('Preview resource was not created.');
      if (spec.type !== 'static') {
        const readiness = waitForHttp(resource.target, spec.readyPath, spec.timeoutMs, signal);
        await (resource.exited ? Promise.race([readiness, resource.exited.then((error) => { throw error; })]) : readiness);
        this.admitted(slot, attempt);
        if (verifyListener) await verifyListener();
      }
      this.admitted(slot, attempt);
      const old = slot.active;
      slot.gateway.setTarget(resource.target);
      slot.active = attempt;
      slot.candidate = undefined;
      slot.latest = attempt;
      attempt.summary.state = 'ready';
      attempt.summary.readyAt = new Date().toISOString();
      committed = true;
      if (resource.exited) void resource.exited.then((error) => this.resourceFailed(slot, attempt, error));
      if (old?.resource) {
        slot.cleanup.add(old);
        await slot.gateway.drain(old.resource.target);
        await this.cleanupAttempt(slot, old);
      }
    } catch (error) {
      if (!committed) {
        const canceled = signal.aborted;
        attempt.controller.abort();
        attempt.summary.state = canceled ? 'canceled' : 'failed';
        if (attempt.summary.state !== 'canceled') attempt.summary.error = redactedFailure(error, input);
        slot.latest = attempt;
        await this.cleanupAttempt(slot, attempt).catch(() => {});
      } else {
        // The new route remains active when retiring the old resource fails.
        attempt.summary.state = 'cleanup-incomplete';
        attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
      }
    } finally {
      if (slot.candidate === attempt) slot.candidate = undefined;
      if (!slot.active && slot.gateway) {
        await this.closeGateway(slot).catch((error) => {
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

  private async stopSlot(slot: Slot): Promise<void> {
    await slot.operation;
    const attempts = new Set([...slot.cleanup, ...[slot.active, slot.candidate, slot.latest].filter((value): value is Attempt => !!value)]);
    await Promise.allSettled([...attempts].map((attempt) => this.cleanupAttempt(slot, attempt)));
    slot.active = undefined;
    slot.candidate = undefined;
    await this.closeGateway(slot);
    if (slot.cleanup.size) throw new PreviewError('CLEANUP_INCOMPLETE', 'Some owned resources could not be verified as stopped. The cleanup handles remain available for retry.');
  }

  private async resourceFailed(slot: Slot, attempt: Attempt, error: Error): Promise<void> {
    if (slot.active !== attempt || slot.stopping) return;
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
    return {
      name: slot.name, ...(slot.gateway ? { url: slot.gateway.url } : {}),
      ...(slot.active ? { active: copySummary(slot.active.summary) } : {}),
      ...(slot.candidate ? { candidate: copySummary(slot.candidate.summary) } : {}),
      ...(slot.latest ? { latest: copySummary(slot.latest.summary) } : {}),
      busy: !!slot.operation || !!slot.stopping,
      ...(slot.cleanup.size ? { cleanup: [...slot.cleanup].filter((attempt) => attempt.summary.state === 'cleanup-incomplete').map((attempt) => ({ attemptId: attempt.summary.id, error: attempt.summary.error! })) } : {}),
    };
  }
  private assertOpen(): void { if (this.closed) throw new PreviewError('CLOSED', 'This runtime is closed.'); }
  private slot(name: string, missingCode: 'NOT_FOUND' | 'ATTEMPT_EXPIRED' = 'NOT_FOUND'): Slot {
    if (!nameSchema.safeParse(name).success) throw new PreviewError('INVALID_INPUT', 'Invalid preview name.');
    const slot = this.slots.get(name);
    if (!slot) throw new PreviewError(missingCode, 'This preview or attempt is not available in the bounded runtime history.');
    return slot;
  }
  private attempt(slot: Slot, id: string): Attempt {
    const attempt = [slot.active, slot.candidate, slot.latest, ...slot.cleanup].find((value) => value?.summary.id === id);
    if (!attempt) throw new PreviewError('ATTEMPT_EXPIRED', 'The attempt is unknown or its bounded history expired.');
    return attempt;
  }
  private prune(): void {
    const terminal = [...this.slots.values()].filter((slot) => !isLive(slot));
    for (const slot of terminal.slice(0, Math.max(0, terminal.length - limits.terminalRecords))) this.slots.delete(slot.name);
  }
}

function isLive(slot: Slot): boolean { return !!(slot.active || slot.candidate || slot.operation || slot.stopping || slot.gateway || slot.cleanup.size); }
function copySummary(summary: AttemptSummary): AttemptSummary { return { ...summary, ...(summary.error ? { error: { ...summary.error } } : {}) }; }
function appendLog(attempt: Attempt, text: string): void {
  const bytes = Buffer.from(text);
  const combined = Buffer.concat([attempt.log, bytes]);
  attempt.truncated ||= combined.length > limits.logBytes;
  attempt.log = combined.subarray(Math.max(0, combined.length - limits.logBytes));
}
function redactedFailure(error: unknown, spec: EffectiveSpec) {
  const result = failure(error);
  if (spec.type === 'command') {
    for (const value of Object.values(spec.env).filter(Boolean).sort((a, b) => b.length - a.length)) {
      const utf8 = Buffer.from(value).toString('utf8');
      result.message = result.message.replaceAll(value, '[redacted]').replaceAll(utf8, '[redacted]').replaceAll(encodeURIComponent(utf8), '[redacted]');
    }
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
