import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { limits, type PreviewSpec, type SecretSetupContext, type SecretSetupStatus, type WaitOptions } from './contracts.js';
import { failure, PreviewError, throwIfAborted } from './errors.js';
import { keychain, validateSecretValue } from './keychain.js';
import type { PreparedSecretSetup, PreviewRuntime } from './runtime.js';

interface Entry {
  status: SecretSetupStatus;
  capability?: string;
  work?: Promise<SecretSetupStatus>;
  controller?: AbortController;
  approve?: PreparedSecretSetup['approve'];
}

/** The daemon owns short-lived form grants and bounded public results. */
export class SecretSetup {
  private readonly entries = new Map<string, Entry>();
  private readonly preparing = new Map<AbortController, Promise<SecretSetupStatus>>();
  private lastLaunch = -Infinity;
  private closed = false;
  constructor(private readonly runtime: PreviewRuntime, readonly origin: string) {}

  setup(input: PreviewSpec | string, signal: AbortSignal, reopen = false): Promise<SecretSetupStatus> {
    if (this.closed) return Promise.reject(new PreviewError('CLOSED', 'The daemon is shutting down.'));
    const controller = new AbortController();
    const work = this.prepare(input, AbortSignal.any([signal, controller.signal]), reopen).finally(() => this.preparing.delete(controller));
    this.preparing.set(controller, work);
    return work;
  }

  private async prepare(input: PreviewSpec | string, signal: AbortSignal, reopen: boolean): Promise<SecretSetupStatus> {
    this.prune();
    if (this.closed) throw new PreviewError('CLOSED', 'The daemon is shutting down.');
    const { context, approve } = await this.runtime.prepareSecretSetup(input, signal);
    const { alreadyPresent, remaining } = await this.presence(context, signal);
    throwIfAborted(signal);
    this.prune();
    if (this.closed) throw new PreviewError('CLOSED', 'The daemon is shutting down.');
    const concurrent = this.findPending(context);
    if (concurrent) {
      if (concurrent.work || JSON.stringify(concurrent.status.remaining) === JSON.stringify(remaining)) {
        if (!concurrent.work) {
          concurrent.status.requirements = context.requirements;
          concurrent.approve = approve;
        }
        if (reopen && !concurrent.work) await this.launch(concurrent, signal);
        return structuredClone(concurrent.status);
      }
      // Rechecking after CLI input can finish setup. Never change a grant's permitted fields.
      delete concurrent.capability; delete concurrent.approve;
      concurrent.status.state = 'canceled';
    }
    if ([...this.entries.values()].filter((entry) => ['pending', 'saving'].includes(entry.status.state)).length >= limits.secretRequests) {
      throw new PreviewError('BUSY', 'At most eight secret forms can be pending. Close or cancel an earlier form.');
    }
    if (remaining.length && performance.now() - this.lastLaunch < 1000) throw new PreviewError('BUSY', 'Wait one second before opening another secret form.');
    const status: SecretSetupStatus = { ...context, id: randomUUID(), state: remaining.length ? 'pending' : 'complete',
      expiresAt: new Date(Date.now() + limits.secretSetupMs).toISOString(), browser: 'not-needed', saved: [], alreadyPresent, remaining };
    const entry: Entry = { status, approve, ...(remaining.length ? { capability: randomBytes(32).toString('hex') } : {}) };
    this.entries.set(status.id, entry);
    if (entry.capability) await this.launch(entry, signal);
    this.prune();
    return structuredClone(status);
  }

  status(id: string): SecretSetupStatus {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new PreviewError('NOT_FOUND', 'This secret request expired from the daemon history. Create a new setup request.');
    return structuredClone(entry.status);
  }

  async wait(id: string, options: WaitOptions = {}): Promise<SecretSetupStatus> {
    const timeout = options.timeoutMs ?? 0;
    if (options.timeoutMs !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > limits.secretWaitMs)) {
      throw new PreviewError('INVALID_INPUT', `Secret status waits must be between 1 and ${limits.secretWaitMs} milliseconds.`);
    }
    const deadline = performance.now() + timeout;
    while (true) {
      if (options.signal?.aborted) throw new PreviewError('CLOSED', 'The secret status wait was canceled. The form remains available.');
      const status = this.status(id);
      const remaining = deadline - performance.now();
      if (!['pending', 'saving'].includes(status.state) || remaining <= 0) return status;
      await delay(Math.min(100, remaining), undefined, { signal: options.signal }).catch(() => {
        throw new PreviewError('CLOSED', 'The secret status wait was canceled. The form remains available.');
      });
    }
  }

  form(authorization: string): SecretSetupStatus { return structuredClone(this.authorized(authorization).status); }

  cancel(authorization: string): SecretSetupStatus {
    const entry = this.authorized(authorization);
    delete entry.capability; delete entry.approve;
    entry.status.state = 'canceled';
    return structuredClone(entry.status);
  }

  /** Only the browser capability can reach this operation. No control-token route approves names. */
  async approve(authorization: string): Promise<SecretSetupStatus> {
    const entry = this.authorized(authorization);
    const approve = entry.approve;
    if (!approve) return structuredClone(entry.status);
    const controller = new AbortController();
    entry.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 30_000);
    entry.work = (async () => {
      try {
        const context = await approve(controller.signal);
        entry.status.requirements = context.requirements;
        delete entry.approve;
        const presence = await this.presence(context, controller.signal);
        throwIfAborted(controller.signal);
        Object.assign(entry.status, presence);
        entry.status.state = presence.remaining.length ? 'pending' : 'complete';
        if (entry.status.state === 'complete') delete entry.capability;
      } catch (error) {
        delete entry.capability; delete entry.approve;
        entry.status.error = failure(error);
        if (entry.status.state === 'pending') entry.status.state = 'partial';
      }
      return structuredClone(entry.status);
    })().finally(() => { clearTimeout(deadline); delete entry.controller; delete entry.work; this.prune(); });
    return entry.work;
  }

  async save(authorization: string, input: unknown): Promise<SecretSetupStatus> {
    const entry = this.authorized(authorization);
    if (entry.approve) throw new PreviewError('SECRET_DENIED', 'Approve the requested secret names in this private form before entering values.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('values' in input)
      || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) {
      throw new PreviewError('INVALID_INPUT', 'Supply only the requested secret fields.');
    }
    const values = input.values as Record<string, unknown>;
    const ids = entry.status.remaining;
    if (Object.keys(values).length !== ids.length || ids.some((id) => !Object.hasOwn(values, id))) {
      throw new PreviewError('INVALID_INPUT', 'Supply exactly the requested secret fields.');
    }
    for (const id of ids) validateSecretValue(values[id]);
    // Consume before the first await. A second request can never replay this write.
    delete entry.capability;
    entry.status.state = 'saving';
    const controller = new AbortController();
    entry.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 30_000);
    entry.work = (async () => {
      for (const id of [...ids]) {
        try {
          throwIfAborted(controller.signal);
          const options = { signal: controller.signal, interactive: true };
          if (entry.status.mode === 'missing') {
            const added = await keychain.add('user', id, values[id] as string, options);
            (added ? entry.status.saved : entry.status.alreadyPresent).push(id);
          } else {
            if (!await keychain.update('user', id, values[id] as string, options)) {
              throw new PreviewError('SECRET_REQUIRED', 'This entry was removed before the edit. Its value was not recreated.');
            }
            entry.status.saved.push(id);
          }
          entry.status.remaining = entry.status.remaining.filter((item) => item !== id);
        } catch (error) {
          entry.status.error = failure(error);
          break;
        }
      }
      entry.status.state = entry.status.remaining.length ? 'partial' : 'complete';
      return structuredClone(entry.status);
    })().finally(() => { clearTimeout(deadline); delete entry.controller; delete entry.work; this.prune(); });
    return entry.work;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.preparing.keys()) controller.abort();
    for (const entry of this.entries.values()) {
      delete entry.capability; delete entry.approve;
      if (entry.status.state === 'pending') entry.status.state = 'canceled';
      entry.controller?.abort();
    }
    await Promise.allSettled([...this.preparing.values(), ...[...this.entries.values()].flatMap((entry) => entry.work ? [entry.work] : [])]);
  }

  /** Kept on the owner to test private launch delivery without exposing it on a transport. */
  async openBrowser(url: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
      const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', env });
      let failed = false;
      const abort = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(abort, 5000);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => { failed = true; });
      child.once('close', (code) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (failed || code !== 0) reject(new PreviewError('START_FAILED', 'The browser could not open. Use previewhost secrets set with hidden terminal input, then retry.'));
        else resolve();
      });
      if (signal.aborted) abort();
    });
  }

  private async launch(entry: Entry, signal: AbortSignal): Promise<void> {
    if (!entry.capability) return;
    if (performance.now() - this.lastLaunch < 1000) throw new PreviewError('BUSY', 'Wait one second before opening another secret form.');
    this.lastLaunch = performance.now();
    try {
      await this.openBrowser(`${this.origin}/secrets#${entry.capability}`, signal);
      entry.status.browser = 'opened';
    } catch {
      entry.status.browser = 'failed';
    }
  }

  private findPending(context: SecretSetupContext): Entry | undefined {
    const requirements = (value: SecretSetupContext) => JSON.stringify(value.requirements.map(({ id, bindings }) => ({ id, bindings })));
    return [...this.entries.values()].find(({ status }) => status.state === 'pending' && status.mode === context.mode && status.name === context.name
      && JSON.stringify(status.sources) === JSON.stringify(context.sources) && requirements(status) === requirements(context));
  }

  private async presence(context: SecretSetupContext, signal: AbortSignal) {
    const alreadyPresent: string[] = [];
    const remaining: string[] = [];
    for (const item of context.requirements) {
      // An unselected name reveals no Keychain metadata before private approval.
      if (!item.selected) { remaining.push(item.id); continue; }
      const exists = await keychain.has('user', item.id, { signal });
      if (context.mode === 'edit' && !exists) throw new PreviewError('SECRET_REQUIRED', 'This entry no longer exists. Use missing-value setup or the owner set command.');
      if (exists && context.mode === 'missing') alreadyPresent.push(item.id);
      else remaining.push(item.id);
    }
    return { alreadyPresent, remaining };
  }

  private authorized(header: string): Entry {
    this.prune();
    if (this.closed || !/^Bearer [a-f0-9]{64}$/.test(header)) throw new PreviewError('UNAUTHORIZED', 'This private form is unavailable. Open a new secret setup request.');
    const supplied = Buffer.from(header.slice(7));
    const entry = [...this.entries.values()].find((item) => item.capability && timingSafeEqual(supplied, Buffer.from(item.capability)));
    if (!entry || entry.status.state !== 'pending') throw new PreviewError('UNAUTHORIZED', 'This private form was used, canceled or expired. Open a new setup request.');
    if (entry.work) throw new PreviewError('BUSY', 'This private request is already in progress. Wait for its result.');
    return entry;
  }

  private prune(): void {
    for (const entry of this.entries.values()) if (entry.status.state === 'pending' && Date.parse(entry.status.expiresAt) <= Date.now()) {
      delete entry.capability; delete entry.approve; entry.controller?.abort(); entry.status.state = 'expired';
    }
    const finished = [...this.entries.values()].filter((entry) => !entry.work && !['pending', 'saving'].includes(entry.status.state));
    for (const entry of finished.slice(0, Math.max(0, finished.length - limits.secretResults))) this.entries.delete(entry.status.id);
  }
}
