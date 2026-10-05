import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AttemptLog } from './logs.js';
import {
  limits, needsExecution, nameSchema, requestSchemas, type AttemptResult, type AttemptSummary, type EffectiveSpec, type Failure,
  type LogResult, type LogOptions, type DeleteDataOptions, type PreviewDescription, type PreviewApi, type PreviewSpec, type PreviewStatus, type RuntimeOptions, type WaitOptions, type StartOptions, type StopOptions, type SecretSetupContext,
  type ConfigurationBindingChange, type DependencyBinding, type ConfigurationBindingsInspection, type ConfigureBindingsOptions, type ConfigureBindingsResult, type SecretSetupApi,
} from './contracts.js';
import { PreviewError, failure, throwIfAborted } from './errors.js';
import { attachmentTarget, isWithin, browserHostname, canonicalDirectory, describeSpec, environmentDependencies, normalizeSpec, parseSpec, resolveInput, sameSources, sourceDirectories, validateResolvedInputs } from './spec.js';
import { createGateway, type Gateway } from './gateway.js';
import { startStatic } from './static.js';
import { startNative } from './native.js';
import { waitForHttp } from './readiness.js';
import type { Resource } from './resources.js';
import { startEnvironment } from './environment.js';
import { createDataOwner, type DataOwner } from './data.js';
import { requireSelected, resolveSecrets, secretRequirements, validateSecretId } from './secrets.js';
import { Keystore } from './keystore.js';
import { changeConfigurationBindings, changeDependencyBinding, configurationBindings, savePreviewSpec } from './config.js';
import { inspectPreviewSpec, runtimeContext } from './inspection.js';
import { openRuntimeRecords, type RuntimeRecords } from './runtime-records.js';
import { makePrivateDirectory } from './private-files.js';
import { ComposeOwner } from './compose.js';

interface Attempt {
  summary: AttemptSummary;
  declaration: EffectiveSpec;
  sourceFile?: string;
  controller: AbortController;
  completed: boolean;
  waiters: Set<() => void>;
  resource?: Resource;
  log: AttemptLog;
  cleanupTask?: Promise<void>;
  recover?: () => Promise<void>;
  nodes: number;
  failure?: Failure;
  held?: boolean;
  candidateGateway?: Gateway;
  restored?: boolean;
  retained?: boolean;
  compose?: PreviewDescription['compose'];
}
interface Slot {
  name: string;
  gateway?: Gateway;
  active?: Attempt;
  candidate?: Attempt;
  latest?: Attempt;
  history?: Attempt[];
  operation?: Promise<void>;
  stopping?: Promise<void>;
  cleanup: Set<Attempt>;
  control?: AbortController;
}
interface ConfigureBindingsContext {
  projectDirectory?: string;
  signal?: AbortSignal;
  secretsSetup?: SecretSetupApi['secretsSetup'];
}

export interface PreviewRuntime extends PreviewApi {
  readonly keystore: Keystore;
  /** Owner-only candidate for a verifier. It cannot replace the serving application until promoted. */
  prepareCandidate(spec: PreviewSpec, options?: StartOptions): Promise<PreviewStatus>;
  candidateUrl(name: string, attemptId: string): string;
  /** Keeps the prior resource alive until owner settlement succeeds; rejection restores its route. */
  promote(name: string, attemptId: string, settle?: () => Promise<void>): Promise<PreviewStatus>;
  sourceRoots(): string[];
  releaseSources(directories: string[]): void;
  /** Forget stopped history only; resource deletion is a separate authorized operation. */
  remove(name: string | undefined, attemptId: string | null): Promise<boolean>;
  isEmpty(): boolean;
  allowSources(directories: string[], signal: AbortSignal): Promise<void>;
  describe(name: string, attemptId: string): Promise<PreviewDescription>;
  startAgain(name: string, attemptId: string): Promise<PreviewStatus>;
  /** The serving owner supplies the destination; control callers cannot choose a path. */
  saveConfiguration(name: string, attemptId: string, projectDirectory: string, signal?: AbortSignal): Promise<{ file: string; externalSources: string[] }>;
  configureBindings<T extends ConfigureBindingsOptions>(name: string, attemptId: string, changes: ConfigurationBindingChange[], options: T,
    context?: ConfigureBindingsContext): Promise<ConfigureBindingsResult<T>>;
  configureDependency<T extends ConfigureBindingsOptions>(name: string, attemptId: string, service: string, binding: DependencyBinding, options: T,
    context?: ConfigureBindingsContext): Promise<ConfigureBindingsResult<T>>;
  configureSource(name: string, attemptId: string, service: string | undefined, directory: string, expected: NonNullable<StopOptions['expected']>): Promise<PreviewStatus>;
  /** Excludes an owner's private directory from current and future static previews. */
  protectDirectory(directory: string): Promise<void>;
  /** Validates and authorizes a private form without reading values or starting code. */
  prepareSecretSetup(input: PreviewSpec | string, signal: AbortSignal): Promise<PreparedSecretSetup>;
  close(): Promise<void>;
}

/** The approval closure stays with the owner-private form, never on a control transport. */
export interface PreparedSecretSetup {
  context: SecretSetupContext;
  approve?: (signal: AbortSignal) => Promise<SecretSetupContext>;
}

export async function createPreviewRuntime(options: RuntimeOptions): Promise<PreviewRuntime> {
  const { roots, inputs, secretIds } = await runtimeContext(options);
  let keystoreDirectory = options.keystoreDirectory;
  if (keystoreDirectory) {
    if (!isAbsolute(keystoreDirectory)) throw new PreviewError('INVALID_INPUT', 'The keystore directory must be absolute.');
    makePrivateDirectory(keystoreDirectory);
    keystoreDirectory = await canonicalDirectory(keystoreDirectory);
  }
  const keystore = new Keystore(keystoreDirectory);
  const records = options.stateDirectory ? await openRuntimeRecords(options.stateDirectory) : undefined;
  let data: DataOwner | undefined;
  let compose: ComposeOwner | undefined;
  try {
    data = options.dataDirectory ? await createDataOwner({ directory: options.dataDirectory, dockerSocket: options.dockerSocket, keystore }) : undefined;
    compose = options.dataDirectory ? await ComposeOwner.open(`${data!.directory}-compose`, options.dockerSocket) : undefined;
    const runtime = new Runtime(roots, options.authorize, inputs, secretIds, data, keystore, { dataDirectory: options.dataDirectory, dockerSocket: options.dockerSocket }, options.supervisor, records, compose);
    await runtime.recover();
    return runtime;
  } catch (error) {
    await compose?.close();
    await data?.close();
    await records?.close();
    keystore.close();
    throw error;
  }
}

class Runtime implements PreviewRuntime {
  private readonly slots = new Map<string, Slot>();
  private readonly privateDirectories = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly roots: string[], private readonly authorize: RuntimeOptions['authorize'],
    private readonly inputs: Readonly<Record<string, string>>, private readonly secretIds: Set<string>, private readonly data: DataOwner | undefined, readonly keystore: Keystore,
    private readonly storage: Pick<RuntimeOptions, 'dataDirectory' | 'dockerSocket'>,
    private readonly supervisor: RuntimeOptions['supervisor'],
    private readonly records?: RuntimeRecords,
    private readonly compose?: ComposeOwner,
  ) {
    this.privateDirectories.add(keystore.directory);
    if (data) this.privateDirectories.add(data.directory);
    if (records) this.privateDirectories.add(records.directory);
    if (compose) this.privateDirectories.add(compose.directory);
    for (const name of [...(data?.names() ?? []), ...(compose?.names() ?? [])]) this.slots.set(name, { name, cleanup: new Set() });
  }

  async recover(): Promise<void> {
    for (const record of this.records?.entries() ?? []) {
      const attempt: Attempt = {
        summary: { id: record.attemptId, type: record.spec.type, state: 'stopped', startedAt: record.startedAt,
          sources: [...new Set([...sourceDirectories(record.spec), ...Object.values(record.processes).map(process => process.source)])] },
        declaration: record.spec, sourceFile: record.sourceFile, controller: new AbortController(), completed: true,
        waiters: new Set(), log: new AttemptLog(), nodes: nodeCost(record.spec), restored: true, retained: true,
      };
      const slot: Slot = { name: record.spec.name, latest: attempt, cleanup: new Set() };
      this.slots.set(slot.name, slot);
      try { await this.records!.recover(slot.name); }
      catch (error) {
        attempt.summary.state = 'cleanup-incomplete';
        attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
        attempt.recover = () => this.records!.recover(slot.name);
        slot.cleanup.add(attempt);
      }
    }
    let recovered = ![...this.slots.values()].some(slot => slot.cleanup.size);
    for (const name of this.compose?.names() ?? []) {
      try { await this.compose!.stop(name); }
      catch (error) {
        recovered = false;
        const attempt = this.slots.get(name)?.latest;
        if (attempt) { attempt.summary.state = 'cleanup-incomplete'; attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE'); }
      }
    }
    if (recovered) await this.compose?.clearStoppedCommands();
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

  sourceRoots(): string[] { return [...this.roots]; }

  releaseSources(directories: string[]): void {
    this.assertOpen();
    if (directories.some(directory => !isAbsolute(directory))) throw new PreviewError('INVALID_INPUT', 'Release canonical absolute source paths.');
    const selected = directories.map(directory => resolve(directory));
    for (const slot of this.slots.values()) {
      const live = [...slot.cleanup, ...[slot.active, slot.candidate].filter((attempt): attempt is Attempt => !!attempt)];
      if (live.some(attempt => attempt.summary.sources.some(source => selected.some(directory => isWithin(directory, source) || isWithin(source, directory))))) {
        throw new PreviewError('BUSY', `Source is in use by preview ${slot.name}. Stop it before removing this folder.`);
      }
    }
    // Removal and the live-consumer check are synchronous. New candidates must
    // pass source authorization again before they can execute.
    const remaining = this.roots.filter(root => !selected.some(directory => isWithin(directory, root)));
    this.roots.splice(0, this.roots.length, ...remaining);
  }

  async allowSources(directories: string[], signal: AbortSignal): Promise<void> {
    this.assertOpen();
    const checked = await Promise.all(directories.map(canonicalDirectory));
    if (!this.authorize || !await abortable(Promise.resolve(this.authorize({ operation: 'allow-sources', directories: checked, signal })), signal)) {
      throw new PreviewError('EXECUTION_DENIED', 'The owner does not permit additional sources.');
    }
    const again = await Promise.all(directories.map(canonicalDirectory));
    if (checked.some((path, i) => path !== again[i])) throw new PreviewError('SOURCE_DENIED', 'A source directory changed during approval.');
    this.assertOpen();
    throwIfAborted(signal);
    const roots = [...new Set([...this.roots, ...checked])];
    if (roots.length > 32) throw new PreviewError('BUSY', 'At most 32 source roots may be approved for one owner.');
    this.roots.splice(0, this.roots.length, ...roots);
  }

  async inspect(input: PreviewSpec) {
    this.assertOpen();
    const description = await inspectPreviewSpec(input, { ...this.storage, roots: this.roots, inputs: this.inputs, secretIds: this.secretIds }, this.privateDirectories);
    this.assertOpen();
    return description;
  }

  async prepareSecretSetup(input: PreviewSpec | string, signal: AbortSignal): Promise<PreparedSecretSetup> {
    this.assertOpen();
    throwIfAborted(signal);
    const mode = typeof input === 'string' ? 'edit' : 'missing';
    if (typeof input === 'string') validateSecretId(input);
    const spec = typeof input === 'string' ? undefined : await abortable(normalizeSpec(parseSpec(input), this.roots, this.inputs, this.privateDirectories), signal);
    const requirements = spec ? secretRequirements(spec, this.secretIds) : [{ id: input as string, selected: this.secretIds.has(input as string), bindings: [] }];
    if (mode === 'edit') requireSelected(requirements);
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
    const context: SecretSetupContext = { mode, ...(spec ? { name: spec.name } : {}), sources: spec ? sourceDirectories(spec) : [], requirements };
    if (!spec || requirements.every((item) => item.selected)) return { context };
    return { context,
      approve: async (approvalSignal: AbortSignal) => {
        this.assertOpen();
        throwIfAborted(approvalSignal);
        const checked = await abortable(normalizeSpec(spec, this.roots, this.inputs, this.privateDirectories), approvalSignal);
        if (!sameSources(spec, checked)) throw new PreviewError('SOURCE_DENIED', 'The source directory changed before secret access approval.');
        this.assertOpen();
        throwIfAborted(approvalSignal);
        const ids = secretRequirements(spec, this.secretIds).map((item) => item.id);
        if (new Set([...this.secretIds, ...ids]).size > limits.secrets) {
          throw new PreviewError('INVALID_INPUT', `A runtime can select at most ${limits.secrets} secret names. Shut it down before choosing a different set.`);
        }
        // No await between the limit check and additions: concurrent approvals form one bounded union.
        for (const id of ids) this.secretIds.add(id);
        return { ...context, requirements: secretRequirements(spec, this.secretIds) };
      },
    };
  }

  async start(input: PreviewSpec, options: StartOptions = {}): Promise<PreviewStatus> {
    return this.startWithMode(input, options, false);
  }

  private startWithMode(input: PreviewSpec, options: StartOptions, held: boolean): PreviewStatus {
    this.assertOpen();
    const spec = parseSpec(input);
    if (!requestSchemas.start.safeParse({ ...options, spec }).success || options.sourceFile !== undefined && !isAbsolute(options.sourceFile)) {
      throw new PreviewError('INVALID_INPUT', 'Use valid start options and an absolute source file path.');
    }
    const previous = this.slots.get(spec.name);
    checkExpectedSlot(previous, options.expected);
    if (previous?.candidate || previous?.operation || previous?.stopping) throw new PreviewError('BUSY', 'This preview already has an operation in progress.');
    if (previous?.cleanup.size || previous?.gateway && !previous.active) throw new PreviewError('CLEANUP_INCOMPLETE', 'Retry stop to resolve the remaining cleanup before starting this name.');
    if (previous?.active) throw new PreviewError('ALREADY_EXISTS', 'This name is active. Use replace to start a candidate.');
    if (this.dataStatus(spec.name)?.cleanup) throw new PreviewError('CLEANUP_INCOMPLETE', 'Resolve retained database cleanup with stop before starting this name.');
    if ([...this.slots.values()].filter(isLive).length >= limits.livePreviews) {
      throw new PreviewError('BUSY', `At most ${limits.livePreviews} previews can be active or awaiting cleanup.`);
    }
    this.checkNodeCapacity(spec);
    const slot: Slot = { name: spec.name, cleanup: new Set(), history: previous?.history };
    this.slots.delete(spec.name);
    this.slots.set(spec.name, slot);
    return this.begin(slot, spec, 'start', options.sourceFile, undefined, held);
  }

  async replace(name: string, input: PreviewSpec, options: StartOptions = {}): Promise<PreviewStatus> {
    return this.replaceWithMode(name, input, options, false);
  }

  private replaceWithMode(name: string, input: PreviewSpec, options: StartOptions, held: boolean): PreviewStatus {
    this.assertOpen();
    const spec = parseSpec(input);
    if (!requestSchemas.replace.safeParse({ ...options, name, spec }).success || options.sourceFile !== undefined && !isAbsolute(options.sourceFile)) {
      throw new PreviewError('INVALID_INPUT', 'Use valid replacement options and an absolute source file path.');
    }
    checkExpectedSlot(this.slots.get(name), options.expected);
    const slot = this.slot(name);
    if (spec.name !== name) throw new PreviewError('INVALID_INPUT', 'The replacement spec must use the same preview name.');
    if (slot.candidate || slot.operation || slot.stopping) throw new PreviewError('BUSY', 'This preview already has an operation in progress.');
    if (slot.cleanup.size) throw new PreviewError('CLEANUP_INCOMPLETE', 'Resolve remaining cleanup with stop before replacing this preview.');
    if (!slot.active) throw new PreviewError('NOT_FOUND', 'This preview has no active target. Use start.');
    if ((slot.active.summary.type === 'environment') !== (spec.type === 'environment')) {
      throw new PreviewError('INVALID_INPUT', 'Stop before changing between an environment and a single preview.');
    }
    this.checkNodeCapacity(spec);
    return this.begin(slot, spec, 'replace', options.sourceFile, undefined, held);
  }

  async prepareCandidate(input: PreviewSpec, options: StartOptions = {}): Promise<PreviewStatus> {
    return this.slots.get(input.name)?.active ? this.replaceWithMode(input.name, input, options, true) : this.startWithMode(input, options, true);
  }

  candidateUrl(name: string, attemptId: string): string {
    const slot = this.slot(name);
    const candidate = slot.candidate;
    if (candidate?.summary.id !== attemptId || candidate.summary.state !== 'ready' || candidate.controller.signal.aborted || !candidate.candidateGateway || slot.stopping) {
      throw new PreviewError('STALE_ATTEMPT', 'The verified candidate is no longer available.');
    }
    return candidate.candidateGateway.url;
  }

  async promote(name: string, attemptId: string, settle?: () => Promise<void>): Promise<PreviewStatus> {
    this.assertOpen();
    this.candidateUrl(name, attemptId);
    const slot = this.slot(name);
    if (slot.operation) throw new PreviewError('BUSY', 'Wait for candidate preparation to complete.');
    const attempt = slot.candidate!;
    const resource = attempt.resource!;
    resource.assertRunning?.();
    const old = slot.active;
    slot.gateway!.setRoutes(resource.routes ?? { '127.0.0.1': resource.target });
    // Reserve the slot before calling the owner. Stop joins settlement; cancel
    // cannot interrupt a transaction whose durable outcome is not yet known.
    slot.operation = Promise.resolve().then(async () => {
      try {
        await settle?.();
      } catch (error) {
        slot.gateway!.setRoutes(old?.resource?.routes ?? (old?.resource ? { '127.0.0.1': old.resource.target } : undefined));
        throw error;
      }
      slot.active = attempt; slot.candidate = undefined; slot.latest = attempt;
      attempt.held = false;
      try {
        await attempt.candidateGateway!.close();
        attempt.candidateGateway = undefined;
        if (old?.resource) {
          slot.cleanup.add(old);
          await Promise.all([...new Set(Object.values(old.resource.routes ?? { primary: old.resource.target }))].map(target => slot.gateway!.drain(target)));
          await this.cleanupAttempt(slot, old);
        }
      } catch (error) {
        attempt.summary.state = 'cleanup-incomplete';
        attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
        slot.cleanup.add(attempt);
      }
    });
    try { await slot.operation; } finally { slot.operation = undefined; }
    return this.status(slot);
  }

  isEmpty(): boolean { return this.slots.size === 0; }

  async remove(name: string | undefined, attemptId: string | null): Promise<boolean> {
    this.assertOpen();
    if (!requestSchemas.remove.safeParse({ name, attemptId }).success) throw new PreviewError('INVALID_INPUT', 'Invalid entry removal request.');
    if (name === undefined) {
      if (this.slots.size) throw new PreviewError('BUSY', 'Remove this project’s previews first.');
      return false;
    }
    const slot = this.slots.get(name);
    if ((slot?.latest?.summary.id ?? null) !== attemptId) throw new PreviewError('STALE_ATTEMPT', 'This preview changed. Review it before removing its entry.');
    if (slot && isLive(slot)) throw new PreviewError('BUSY', 'Stop the preview and resolve cleanup before removing its entry.');
    if (this.dataStatus(name)) throw new PreviewError('BUSY', 'Delete the retained managed data before removing its entry.');
    if (!slot) return false;
    slot.operation = this.records?.remove(name) ?? Promise.resolve();
    try { await slot.operation; return this.slots.delete(name); }
    finally { slot.operation = undefined; }
  }

  async list(): Promise<PreviewStatus[]> { return [...this.slots.values()].map((slot) => this.status(slot)); }
  async get(name: string): Promise<PreviewStatus> { return this.status(this.slot(name)); }

  async describe(name: string, attemptId: string) {
    const attempt = this.attempt(this.slot(name), attemptId);
    const spec = attempt.declaration;
    const secrets = secretRequirements(spec, this.secretIds);
    return structuredClone({ ...describeSpec(spec), ...(secrets.length ? { secrets } : {}), ...(attempt.sourceFile ? { sourceFile: attempt.sourceFile } : {}), ...(attempt.compose ? { compose: attempt.compose } : {}) });
  }

  async startAgain(name: string, attemptId: string): Promise<PreviewStatus> {
    const slot = this.slot(name);
    const attempt = this.attempt(slot, attemptId);
    if (slot.latest !== attempt || !['stopped', 'failed', 'canceled'].includes(attempt.summary.state)) {
      throw new PreviewError('STALE_ATTEMPT', 'Select the current stopped, failed, or canceled attempt before starting again.');
    }
    // start admits synchronously; its normal startup path revalidates sources and authority.
    return this.start(attempt.declaration, { sourceFile: attempt.sourceFile });
  }

  async rerunJob(name: string, attemptId: string, job: string): Promise<PreviewStatus> {
    this.assertOpen();
    const slot = this.slot(name);
    const attempt = this.attempt(slot, attemptId);
    if (slot.latest !== attempt) throw new PreviewError('STALE_ATTEMPT', 'Select the latest attempt before rerunning a job.');
    if (slot.active || slot.gateway || slot.operation || slot.stopping || slot.cleanup.size || this.dataStatus(name)?.cleanup) {
      throw new PreviewError('BUSY', 'Stop this preview and complete cleanup before rerunning a job. Database writes are not rolled back.');
    }
    const spec = attempt.declaration;
    if (spec.type !== 'environment' || spec.services[job]?.type !== 'job') throw new PreviewError('INVALID_INPUT', 'Select a job in this configuration.');
    if ([...this.slots.values()].filter(isLive).length >= limits.livePreviews) throw new PreviewError('BUSY', 'The live preview limit was reached.');
    this.checkNodeCapacity(spec);
    // Normal start authorization, source checks and secret approvals apply again.
    return this.begin(slot, spec, 'start', attempt.sourceFile, job);
  }

  async saveConfiguration(name: string, attemptId: string, projectDirectory: string, signal?: AbortSignal) {
    this.assertOpen();
    const spec = this.attempt(this.slot(name), attemptId).declaration;
    return savePreviewSpec(spec, { projectDirectory, allowedRoots: this.roots, signal });
  }

  async configureSource(name: string, attemptId: string, service: string | undefined, directory: string, expected: NonNullable<StopOptions['expected']>): Promise<PreviewStatus> {
    this.assertOpen();
    if (!isAbsolute(directory)) throw new PreviewError('INVALID_INPUT', 'Select an absolute source folder.');
    const slot = this.slot(name);
    const attempt = this.attempt(slot, attemptId);
    const spec = parseSpec(attempt.declaration);
    const target = spec.type === 'environment' && service !== undefined ? spec.services[service] : service === undefined ? spec : undefined;
    if (!target) throw new PreviewError('INVALID_INPUT', 'Select an existing service or job.');
    if ('cwd' in target) target.cwd = directory;
    else if (target.type === 'static') target.directory = directory;
    else throw new PreviewError('INVALID_INPUT', 'This service does not use a source folder.');
    return this.configureDeclaration(slot, attempt, parseSpec(spec), { operation: 'apply', expected }, {}) as Promise<PreviewStatus>;
  }

  configureDependency<T extends ConfigureBindingsOptions>(name: string, attemptId: string, service: string, binding: DependencyBinding, options: T,
    context?: ConfigureBindingsContext): Promise<ConfigureBindingsResult<T>>;
  async configureDependency(name: string, attemptId: string, service: string, binding: DependencyBinding, options: ConfigureBindingsOptions,
    context: ConfigureBindingsContext = {}): Promise<ConfigureBindingsResult> {
    this.assertOpen();
    if (!requestSchemas.configureBindings.shape.options.safeParse(options).success) throw new PreviewError('INVALID_INPUT', 'Invalid configuration action.');
    if (context.signal) throwIfAborted(context.signal);
    const slot = this.slot(name);
    const attempt = this.attempt(slot, attemptId);
    return this.configureDeclaration(slot, attempt, changeDependencyBinding(attempt.declaration, service, binding), options, context);
  }

  configureBindings<T extends ConfigureBindingsOptions>(name: string, attemptId: string, changes: ConfigurationBindingChange[], options: T,
    context?: ConfigureBindingsContext): Promise<ConfigureBindingsResult<T>>;
  async configureBindings(name: string, attemptId: string, changes: ConfigurationBindingChange[], options: ConfigureBindingsOptions,
    context: ConfigureBindingsContext = {}): Promise<ConfigureBindingsResult> {
    this.assertOpen();
    if (!requestSchemas.configureBindings.safeParse({ name, attemptId, changes, options }).success) {
      throw new PreviewError('INVALID_INPUT', 'Invalid configuration binding changes.');
    }
    if (context.signal) throwIfAborted(context.signal);
    const slot = this.slot(name);
    const attempt = this.attempt(slot, attemptId);
    const spec = changeConfigurationBindings(attempt.declaration, changes);
    return this.configureDeclaration(slot, attempt, spec, options, context);
  }

  private async configureDeclaration(slot: Slot, attempt: Attempt, spec: EffectiveSpec, options: ConfigureBindingsOptions, context: ConfigureBindingsContext): Promise<ConfigureBindingsResult> {
    const name = slot.name;
    if (options.operation === 'apply') checkExpectedSlot(slot, options.expected);
    if (options.operation === 'inspect') {
      const secrets = secretRequirements(spec, this.secretIds);
      const result: ConfigurationBindingsInspection = {
        description: { ...describeSpec(spec), ...(secrets.length ? { secrets } : {}), ...(attempt.sourceFile ? { sourceFile: attempt.sourceFile } : {}) },
        bindings: configurationBindings(spec),
      };
      try {
        const inspected = await this.inspect(spec);
        result.inspection = { ...(inspected.prerequisites ? { prerequisites: inspected.prerequisites } : {}) };
      } catch (error) { result.inspection = { error: redactedFailure(error, spec, this.inputs) }; }
      return result;
    }
    if (options.operation === 'secrets') {
      if (!context.secretsSetup) throw new PreviewError('INVALID_INPUT', 'Private secret setup requires an owner connection.');
      return context.secretsSetup(spec, { reopen: options.reopen, signal: context.signal });
    }
    if (options.operation === 'save') {
      if (!context.projectDirectory) throw new PreviewError('INVALID_INPUT', 'This owner has no project directory. Save the original spec through the CLI, MCP, or library.');
      return savePreviewSpec(spec, { projectDirectory: context.projectDirectory, allowedRoots: this.roots, signal: context.signal });
    }
    if (attempt !== slot.active && (attempt !== slot.latest || !['failed', 'canceled', 'stopped'].includes(attempt.summary.state))) {
      throw new PreviewError('STALE_ATTEMPT', 'Select the current serving or latest stopped, failed, or canceled configuration before applying changes.');
    }
    // Edited declarations are direct inputs until a caller saves and reloads a file.
    const launch = { expected: options.expected, ...(isDeepStrictEqual(spec, attempt.declaration) ? { sourceFile: attempt.sourceFile } : {}) };
    return slot.active ? this.replace(name, spec, launch) : this.start(spec, launch);
  }

  async wait(name: string, attemptId: string, options: WaitOptions = {}): Promise<AttemptResult> {
    const slot = this.slot(name, 'ATTEMPT_EXPIRED');
    const attempt = this.attempt(slot, attemptId);
    const timeoutMs = options.timeoutMs ?? limits.waitMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.waitMs) {
      throw new PreviewError('INVALID_INPUT', `Wait timeout must be between 1 and ${limits.waitMs} milliseconds.`);
    }
    await waitBounded(attempt, timeoutMs, options.signal);
    return { ...copySummary(attempt), name, ...(slot.active === attempt && slot.gateway ? { url: slot.gateway.url } : {}) };
  }

  async logs(name: string, attemptId?: string, options: LogOptions = {}): Promise<LogResult> {
    const slot = this.slot(name, 'ATTEMPT_EXPIRED');
    if (options.after !== undefined && !attemptId) throw new PreviewError('INVALID_INPUT', 'Incremental logs require an attemptId.');
    const attempt = attemptId ? this.attempt(slot, attemptId) : slot.candidate ?? slot.active ?? slot.latest;
    if (!attempt || attempt.restored) throw new PreviewError('ATTEMPT_EXPIRED', 'The attempt logs are no longer available. Logs are not retained across runtime restarts.');
    if (options.source !== undefined && !(attempt.declaration.type === 'environment' ? Object.hasOwn(attempt.declaration.services, options.source) : attempt.declaration.type === 'compose' ? options.source === name || !!attempt.compose?.services.some(service => service.id === options.source) : options.source === name)) {
      throw new PreviewError('INVALID_INPUT', 'Select a service or job in this attempt.');
    }
    return { name, attemptId: attempt.summary.id, ...attempt.log.read(options) };
  }

  async cancel(name: string, attemptId: string): Promise<PreviewStatus> {
    const slot = this.slot(name);
    if (slot.operation && slot.candidate?.held && slot.candidate.summary.state === 'ready') {
      throw new PreviewError('BUSY', 'Candidate settlement is in progress. Stop waits for its durable outcome.');
    }
    if (!slot.candidate || slot.candidate.summary.id !== attemptId) {
      throw new PreviewError('STALE_ATTEMPT', 'This attempt is no longer the pending candidate.');
    }
    slot.candidate.controller.abort();
    await slot.operation;
    if (slot.candidate?.summary.id === attemptId) {
      const candidate = slot.candidate;
      candidate.summary.state = 'canceled'; slot.latest = candidate;
      await this.cleanupAttempt(slot, candidate);
      slot.candidate = undefined;
      if (!slot.active) await this.closeGateway(slot);
    }
    return this.status(slot);
  }

  async stop(name: string, options: StopOptions = {}): Promise<PreviewStatus> {
    if (!requestSchemas.stop.safeParse({ ...options, name }).success) throw new PreviewError('INVALID_INPUT', 'Invalid stop options.');
    const slot = this.slot(name);
    checkExpectedSlot(slot, options.expected);
    if (options.afterEngineRestart && (slot.active || slot.candidate || slot.operation || slot.stopping)) {
      throw new PreviewError('BUSY', 'Engine-restart recovery requires a stopped environment with no operation in progress.');
    }
    slot.control?.abort();
    if (slot.stopping) { await slot.stopping; return this.status(slot); }
    const settling = slot.operation && slot.candidate?.held && slot.candidate.summary.state === 'ready';
    if (!settling) {
      slot.candidate?.controller.abort();
      slot.active?.controller.abort();
      slot.gateway?.setTarget(undefined);
    }
    const controller = options.afterEngineRestart ? new AbortController() : undefined;
    if (controller) slot.control = controller;
    const stopping = Promise.resolve().then(async () => {
      if (settling) {
        await slot.operation?.catch(() => {});
        slot.candidate?.controller.abort();
        slot.active?.controller.abort();
        slot.gateway?.setTarget(undefined);
      }
      if (controller) {
        await this.authorizeData('recover-data', slot, controller.signal);
      }
      await this.stopSlot(slot, options);
    });
    slot.stopping = stopping;
    try { await stopping; } finally { slot.stopping = undefined; slot.control = undefined; this.prune(); }
    return this.status(slot);
  }

  async deleteData(name: string, options: DeleteDataOptions = {}): Promise<PreviewStatus> {
    if (!requestSchemas.deleteData.safeParse({ ...options, name }).success) throw new PreviewError('INVALID_INPUT', 'Invalid data deletion options.');
    this.assertOpen();
    const slot = this.slot(name);
    if (isLive(slot)) throw new PreviewError('BUSY', 'Stop the environment and resolve application cleanup before deleting data.');
    const data = this.dataStatus(name);
    if (!data) throw new PreviewError('NOT_FOUND', 'This name has no retained database data.');
    if (options.expected) {
      const expected = options.expected;
      const resources = data.resources;
      if ((slot.latest?.summary.id ?? null) !== expected.attemptId || resources.length !== expected.resources.length ||
          resources.some(resource => !expected.resources.some(item => item.name === resource.name && item.type === resource.type))) {
        throw new PreviewError('STALE_ATTEMPT', 'The preview or managed databases changed. Review them before deleting data.');
      }
    }
    const cleanup = data.cleanup;
    if (cleanup && cleanup.operation !== 'remove-credential') throw new PreviewError('CLEANUP_INCOMPLETE', 'Resolve retained cleanup with stop before deleting data.');
    const controller = new AbortController();
    slot.control = controller;
    const operation = Promise.resolve().then(async () => {
      await this.authorizeData('delete-data', slot, controller.signal);
      throwIfAborted(controller.signal);
      this.assertOpen();
      if (this.data?.status(name)) await this.data.deleteData(name);
      await this.compose?.deleteData(name);
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
      await this.compose?.close();
      await this.data?.close();
      await this.records?.close();
      this.keystore.close();
    })();
    try { await this.closing; }
    catch (error) { this.closing = undefined; throw error; }
  }

  private begin(slot: Slot, spec: EffectiveSpec, operation: 'start' | 'replace', sourceFile?: string, rerunJob?: string, held = false): PreviewStatus {
    const attempt: Attempt = {
      summary: { id: randomUUID(), type: spec.type, state: 'starting', startedAt: new Date().toISOString(), sources: sourceDirectories(spec) },
      declaration: structuredClone(spec), ...(sourceFile ? { sourceFile } : {}), controller: new AbortController(), completed: false, waiters: new Set(),
      log: new AttemptLog(), nodes: nodeCost(spec), held,
    };
    slot.history = [attempt, ...(slot.history ?? [])].slice(0, limits.attemptsPerPreview);
    slot.candidate = attempt;
    slot.operation = this.runCandidate(slot, attempt, spec, operation, rerunJob).finally(() => {
      slot.operation = undefined;
      attempt.completed = true;
      for (const waiter of attempt.waiters) waiter();
      attempt.waiters.clear();
      this.prune();
    });
    return this.status(slot);
  }

  private async runCandidate(slot: Slot, attempt: Attempt, input: EffectiveSpec, operation: 'start' | 'replace', rerunJob?: string): Promise<void> {
    const signal = attempt.controller.signal;
    let committed = false;
    let exclusiveStopped = false;
    let timedOut = false;
    let secrets: Record<string, string> = {};
    let preparedCompose: Awaited<ReturnType<ComposeOwner['prepare']>> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const spec = await abortable(normalizeSpec(input, this.roots, this.inputs, this.privateDirectories), signal);
      attempt.declaration = structuredClone(spec);
      attempt.summary.sources = sourceDirectories(spec);
      if (spec.type === 'compose') {
        if (!this.compose) throw new PreviewError('INVALID_INPUT', 'Compose requires a private dataDirectory.');
        preparedCompose = await this.compose.prepare(spec, signal);
        attempt.compose = preparedCompose.prepared.description;
      }
      this.admitted(slot, attempt);
      if (this.authorize) {
        const approved = await abortable(Promise.resolve(this.authorize({ operation, spec: structuredClone(spec), ...(rerunJob ? { rerunJob } : {}), signal })), signal);
        if (!approved) throw new PreviewError('EXECUTION_DENIED', 'The host denied this preview operation.');
      } else if (needsExecution(spec)) {
        throw new PreviewError('EXECUTION_DENIED', 'Commands and managed databases require host authorization. Start the daemon with --allow-exec only for trusted code.');
      }
      if (spec.type === 'environment' || spec.type === 'compose') {
        deadline = setTimeout(() => {
          timedOut = true; attempt.controller.abort();
        }, spec.timeoutMs);
      }
      this.admitted(slot, attempt);
      // Recheck the selected directory after approval; never silently switch to a new symlink target.
      const checked = await abortable(normalizeSpec(spec, this.roots, this.inputs, this.privateDirectories), signal);
      if (!sameSources(spec, checked)) {
        throw new PreviewError('SOURCE_DENIED', 'The source directory changed during authorization.');
      }
      this.admitted(slot, attempt);
      secrets = await resolveSecrets(secretRequirements(spec, this.secretIds), signal, this.keystore);
      validateResolvedInputs(spec, this.inputs, secrets);
      this.admitted(slot, attempt);
      await this.records?.save(spec, attempt.summary.id, attempt.summary.startedAt, attempt.sourceFile);
      attempt.retained = !!this.records;
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
          supervisor: this.supervisor,
          ownership: this.records?.ownership(slot.name),
          spec: { ...spec, env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, resolveInput(value, this.inputs, secrets)])) },
          url: slot.gateway.url, signal,
          appendLog: (text) => attempt.log.append(text, spec.name),
          onResource: (resource) => { attempt.resource = resource; },
        });
        attempt.resource = resource;
        verifyListener = () => resource.verifyListener();
      } else if (spec.type === 'compose') {
        attempt.summary.services = {};
        attempt.resource = await this.compose!.start(spec, {
          ...preparedCompose!, signal, supervisor: this.supervisor, url: slot.gateway.url,
          ownership: this.records ? () => this.records!.ownership(slot.name) : undefined,
          appendLog: (text, source) => attempt.log.append(text, source),
          serviceStatus: (id, status) => { attempt.summary.services![id] = status; },
          onResource: resource => { attempt.resource = resource; },
          beforeActivation: async () => {
            const old = slot.active;
            if (!old) return;
            slot.gateway?.setTarget(undefined);
            slot.active = undefined;
            old.summary.state = 'stopped';
            await this.cleanupAttempt(slot, old);
            await this.data?.stop(slot.name);
          },
        });
      } else {
        const databases = Object.fromEntries(Object.entries(spec.services).filter((entry) => entry[1].type === 'postgres' || entry[1].type === 'redis')) as
          Record<string, Extract<(typeof spec.services)[string], { type: 'postgres' | 'redis' }>>;
        if (Object.keys(databases).length && !this.data) throw new PreviewError('INVALID_INPUT', 'Managed databases require a private dataDirectory (--data-dir for the daemon).');
        attempt.summary.services = Object.fromEntries(Object.entries(spec.services).map(([id, service]) => [id, {
          type: service.type, state: service.type === 'postgres' || service.type === 'redis' ? 'starting' : 'waiting',
        }]));
        const bindings = this.data && (Object.keys(databases).length || this.data.status(slot.name))
          ? await this.data.open(slot.name, databases, { signal, onFailure: (error) => this.environmentFailed(slot, error) }) : {};
        this.admitted(slot, attempt);
        attempt.resource = await startEnvironment({
          supervisor: this.supervisor,
          ownership: this.records ? () => this.records!.ownership(slot.name) : undefined,
          beforeExclusiveStart: async () => {
            exclusiveStopped = true;
            await slot.active?.resource?.stopExclusive?.();
          },
          resolvePreview: (name, service) => {
            if (name === slot.name) return;
            const resource = this.slots.get(name)?.active?.resource;
            return service ? resource?.routes?.[browserHostname(name, service)] : resource?.target;
          },
          spec, url: slot.gateway.url, inputs: this.inputs, secrets, databases: bindings, signal, privateDirectories: this.privateDirectories, data: this.data, rerunJob,
          appendLog: (text, source) => attempt.log.append(text, source),
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
      if (resource.exited) void resource.exited.then((error) => this.resourceFailed(slot, attempt, error));
      if (attempt.held) {
        attempt.candidateGateway = await createGateway({ publicPort: Number(new URL(slot.gateway.url).port), onError: error => { void this.resourceFailed(slot, attempt, error); } });
        this.admitted(slot, attempt);
        attempt.candidateGateway.setRoutes(resource.routes ?? { '127.0.0.1': resource.target });
        attempt.summary.state = 'ready';
        attempt.summary.readyAt = new Date().toISOString();
        slot.latest = attempt;
        return;
      }
      const old = slot.active;
      slot.gateway.setRoutes(resource.routes ?? { '127.0.0.1': resource.target });
      slot.active = attempt;
      slot.candidate = undefined;
      slot.latest = attempt;
      attempt.summary.state = 'ready';
      attempt.summary.readyAt = new Date().toISOString();
      committed = true;
      clearTimeout(deadline);

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
        if (exclusiveStopped && !slot.cleanup.has(attempt)) {
          try { await slot.active?.resource?.restoreExclusive?.(); }
          catch (restoreError) {
            if (slot.active) await this.resourceFailed(slot, slot.active, restoreError instanceof Error ? restoreError : new Error('Exclusive worker restoration failed.'));
          }
        }
      } else {
        // The new route remains active when retiring the old resource fails.
        attempt.summary.state = 'cleanup-incomplete';
        attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
      }
    } finally {
      clearTimeout(deadline);
      if (preparedCompose && !attempt.resource) await preparedCompose.cli.close();
      if (slot.candidate === attempt && !(attempt.held && attempt.summary.state === 'ready')) slot.candidate = undefined;
      if (!slot.active && !slot.candidate && slot.gateway) {
        await this.closeGateway(slot).catch((error) => {
          attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
          attempt.summary.state = 'cleanup-incomplete';
        });
      }
      if (!slot.active && !slot.cleanup.size && this.dataStatus(slot.name)) {
        await this.stopData(slot, [attempt]).catch((error) => {
          attempt.summary.error = failure(error, 'CLEANUP_INCOMPLETE');
          attempt.summary.state = 'cleanup-incomplete';
        });
      }
      // Startup has ended. Unstarted nodes and interrupted preparation are not still waiting.
      for (const service of Object.values(attempt.summary.services ?? {})) {
        if (service.state === 'waiting' || service.state === 'starting') service.state = 'canceled';
      }
    }
  }

  private async cleanupAttempt(slot: Slot, attempt: Attempt): Promise<void> {
    if (attempt.cleanupTask) return attempt.cleanupTask;
    if (!attempt.resource && !attempt.recover && !attempt.candidateGateway) return;
    slot.cleanup.add(attempt);
    attempt.cleanupTask = (async () => {
      try {
        await attempt.resource?.stop();
        await attempt.candidateGateway?.close();
        attempt.candidateGateway = undefined;
        await attempt.recover?.();
        attempt.recover = undefined;
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
    if (slot.latest?.retained) await this.records!.save(slot.latest.declaration, slot.latest.summary.id, slot.latest.summary.startedAt, slot.latest.sourceFile);

    // Listener/data cleanup can fail after the application resource is already gone.
    if (slot.latest?.summary.state === 'cleanup-incomplete') {
      slot.latest.summary.state = 'stopped';
      delete slot.latest.summary.error;
    }
  }

  private async stopData(slot: Slot, attempts: Iterable<Attempt>, options?: StopOptions): Promise<void> {
    await this.data?.stop(slot.name, options);
    await this.compose?.stop(slot.name);
    for (const attempt of attempts) {
      for (const service of Object.values(attempt.summary.services ?? {})) {
        if ((service.type === 'postgres' || service.type === 'redis' || service.type === 'compose') && service.state !== 'failed') service.state = 'stopped';
      }
    }
  }

  private async resourceFailed(slot: Slot, attempt: Attempt, error: Error): Promise<void> {
    if (slot.operation && slot.candidate === attempt && attempt.held && attempt.summary.state === 'ready') {
      await slot.operation.catch(() => {});
    }
    if (slot.candidate === attempt && attempt.held && !slot.stopping) {
      attempt.failure = failure(error);
      attempt.controller.abort();
      try {
        await this.cancel(slot.name, attempt.summary.id);
        attempt.summary.state = 'failed'; attempt.summary.error = failure(error);
      } catch (cleanup) {
        attempt.summary.state = 'cleanup-incomplete'; attempt.summary.error = failure(cleanup, 'CLEANUP_INCOMPLETE');
        slot.cleanup.add(attempt);
      }
      return;
    }
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
    const data = this.dataStatus(slot.name);
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
      const data = this.dataStatus(slot.name);
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
  private dataStatus(name: string) {
    const database = this.data?.status(name);
    const compose = this.compose?.status(name);
    if (!database) return compose;
    if (!compose) return database;
    return { resources: [...database.resources, ...compose.resources], running: database.running || compose.running, cleanup: database.cleanup ?? compose.cleanup };
  }

  private status(slot: Slot): PreviewStatus {
    const data = this.dataStatus(slot.name);
    return {
      name: slot.name, ...(slot.gateway ? { url: slot.gateway.url } : {}),
      ...(slot.active ? { active: copySummary(slot.active) } : {}),
      ...(slot.candidate ? { candidate: copySummary(slot.candidate) } : {}),
      ...(slot.latest ? { latest: copySummary(slot.latest) } : {}),
      ...(slot.history?.length ? { history: slot.history.map(copySummary) } : {}),
      busy: !!slot.operation || !!slot.stopping,
      ...(slot.cleanup.size ? { cleanup: [...slot.cleanup].filter((attempt) => attempt.summary.state === 'cleanup-incomplete').map((attempt) => ({
        attemptId: attempt.summary.id, error: attempt.summary.error!, sources: [...attempt.summary.sources],
      })) } : {}),
      ...(data ? { data } : {}),
    };
  }
  private assertOpen(): void { if (this.closed) throw new PreviewError('CLOSED', 'This runtime is closed.'); }
  private slot(name: string, missingCode: 'NOT_FOUND' | 'ATTEMPT_EXPIRED' = 'NOT_FOUND'): Slot {
    if (!nameSchema.safeParse(name).success) throw new PreviewError('INVALID_INPUT', 'Invalid preview name.');
    let slot = this.slots.get(name);
    if (!slot && this.dataStatus(name)) {
      slot = { name, cleanup: new Set() }; this.slots.set(name, slot);
    }
    if (!slot) throw new PreviewError(missingCode, 'This preview or attempt is not available in the bounded runtime history.');
    return slot;
  }
  private attempt(slot: Slot, id: string): Attempt {
    const attempt = [slot.active, slot.candidate, slot.latest, ...slot.cleanup, ...(slot.history ?? [])].find((value) => value?.summary.id === id);
    if (!attempt) throw new PreviewError('ATTEMPT_EXPIRED', 'The attempt is unknown or its bounded history expired.');
    return attempt;
  }
  private prune(): void {
    const terminal = [...this.slots.values()].filter((slot) => !isLive(slot) && !this.dataStatus(slot.name) && !this.records?.has(slot.name));
    for (const slot of terminal.slice(0, Math.max(0, terminal.length - limits.terminalRecords))) this.slots.delete(slot.name);
  }
}

function checkExpectedSlot(slot: Slot | undefined, expected: StopOptions['expected']): void {
  if (expected && (expected.active !== (slot?.active?.summary.id ?? null) ||
      expected.candidate !== (slot?.candidate?.summary.id ?? null) || expected.latest !== (slot?.latest?.summary.id ?? null))) {
    throw new PreviewError('STALE_ATTEMPT', 'This preview changed. Review its current state before applying this action.');
  }
}
function isLive(slot: Slot): boolean { return !!(slot.active || slot.candidate || slot.operation || slot.stopping || slot.gateway || slot.cleanup.size); }
function copySummary(attempt: Attempt): AttemptSummary {
  const summary = structuredClone(attempt.summary);
  if (summary.state === 'starting' && summary.services && attempt.declaration.type === 'environment') {
    for (const [id, dependencies] of environmentDependencies(attempt.declaration)) {
      const service = summary.services[id];
      if (service?.state !== 'waiting') continue;
      const waitingFor = dependencies.filter(dependency => !['ready', 'succeeded', 'skipped'].includes(summary.services![dependency]?.state));
      if (waitingFor.length) service.waitingFor = waitingFor;
    }
  }
  return summary;
}
function nodeCost(spec: EffectiveSpec): number { return spec.type === 'environment' ? Object.keys(spec.services).length : spec.type === 'compose' ? spec.services.length : 1; }
function redactedFailure(error: unknown, spec: EffectiveSpec, inputs: Readonly<Record<string, string>> = {}, secrets: Readonly<Record<string, string>> = {}) {
  const result = failure(error);
  const values = spec.type === 'command' ? Object.values(spec.env).filter((value): value is string => typeof value === 'string') : spec.type === 'environment'
    ? Object.values(spec.services).flatMap((service) => (service.type === 'command' || service.type === 'worker' || service.type === 'job') ? Object.values(service.env).filter((value): value is string => typeof value === 'string') :
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
