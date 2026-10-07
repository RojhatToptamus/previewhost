import { z } from 'zod';

export const limits = {
  livePreviews: 32,
  terminalRecords: 128,
  logBytes: 65_536,
  attemptsPerPreview: 8,
  gatewayConnections: 256,
  controlBytes: 1_048_576,
  controlRequests: 32,
  controlWaits: 16,
  headerTimeoutMs: 10_000,
  drainMs: 1_000,
  waitMs: 30_000,
  environmentServices: 16,
  environmentDatabases: 4,
  liveNodes: 128,
  retainedEnvironments: 128,
  parallelServices: 4,
  secrets: 128,
  secretBytes: 4096,
  secretOperations: 4,
  secretQueue: 32,
  secretRequests: 8,
  secretResults: 32,
  secretSetupMs: 300_000,
  secretWaitMs: 25_000,
} as const;

export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const readyPath = z.string().max(2048).refine(
  (value) => value.startsWith('/') && !value.startsWith('//') && /^[\x21-\x7e]+$/.test(value) && !value.includes('#'),
  'Use a URL-encoded origin-relative readiness path without whitespace or a fragment.',
).default('/').describe('URL-encoded origin-relative readiness path. HTTP 200–399 headers count as ready; redirects are not followed and bodies are not checked. For database-backed apps, use a health endpoint that queries required tables and returns 503 on failure; /openapi.json does not prove database readiness.');
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000)
  .describe('Service readiness deadline in milliseconds, including any startup preparation. Default 30000; maximum 120000.');
const directory = z.string().min(1).max(4096)
  .describe('Existing live source directory, including uncommitted files. In a direct spec, cwd and directory must be absolute paths, even when project is supplied. JSON/YAML file inputs also support paths relative to that file.');
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const literal = z.string().max(4096).refine((value) => !value.includes('\0'), 'Values cannot contain NUL.');
export const secretIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, 'Use a secret name of 1–128 letters, numbers, dots, dashes, underscores or slashes.')
  .describe('Stored secret reference, not the application environment-variable name. For a new binding, choose a project-specific reference, for example API_SECRET: {secret: "my-project/dev/api"}. Preserve existing references. Use an existing exact reference only for intentional sharing; matching references share one value across projects and worktrees after approval.');
const inputReferenceSchema = z.strictObject({ fromEnv: envKey.describe('Environment input explicitly selected by the daemon owner; not an arbitrary client or shell variable.') });
export const scalarValueSchema = z.union([literal, inputReferenceSchema, z.strictObject({ secret: secretIdSchema })]);
export type ScalarValue = z.output<typeof scalarValueSchema>;
const dependsOn = z.array(nameSchema).max(limits.environmentServices).optional()
  .describe('Wait for these nodes: jobs must exit zero; HTTP services and databases must be ready. Cycles are invalid.');
const argv = z.array(z.string().max(8192).refine((value) => !value.includes('\0'), 'Arguments cannot contain NUL.')).min(1).max(128)
  .refine((value) => value[0].length > 0, 'The executable cannot be empty.')
  .describe('Executable and argv, with no implicit shell: no $PORT expansion, pipes, redirects, or &&. Literal {port} is replaced with the allocated private port. Honor injected PORT and HOST=127.0.0.1 or pass explicit loopback/port flags; disable port fallback. Dependencies must exist or come from explicit project preparation. A command must stay running and serve HTTP, not only exit successfully.');
const envSchema = z.record(envKey, scalarValueSchema)
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'Remove PORT, HOST and PREVIEW_URL from env; Previewhost injects them at runtime.')
  .default({}).describe('Application bindings only. Use {secret: ID} for credentials, including dummy local API keys; never invent credential literals in tool arguments. Do not set PORT, HOST or PREVIEW_URL here. Previewhost injects the private port, HOST=127.0.0.1, and numeric public origin. PREVIEW_URL is not the listen address. Only basic runtime variables such as PATH and HOME are inherited. previewhost does not load .env files; the application can.');

export const environmentValueSchema = z.union([
  scalarValueSchema,
  z.strictObject({ field: z.enum(['host', 'port']).optional(), port: nameSchema.optional(), service: nameSchema.describe('Wait for this service and use its candidate internal numeric HTTP URL or selected database connection URL. Adds a readiness dependency; cycles are invalid.') }),
  z.strictObject({ publicUrl: nameSchema.describe('Primary HTTP service only: numeric public origin. Adds no readiness dependency and can still reach the active application during replacement.') }),
  z.strictObject({ browserUrl: nameSchema.describe('Any HTTP service: public .localhost alias for browser requests. Adds no readiness dependency; native DNS resolution and candidate readiness are not guaranteed. During replacement it can still reach the active application.') }),
]);
export const configurationBindingChangeSchema = z.strictObject({ service: nameSchema.optional(), key: envKey, value: environmentValueSchema.nullable() });
export type ConfigurationBindingChange = z.output<typeof configurationBindingChangeSchema>;
const serviceEnvironment = z.record(envKey, environmentValueSchema)
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'Remove PORT, HOST and PREVIEW_URL from env; Previewhost injects them at runtime.')
  .default({}).describe('Application bindings only. Use {secret: ID} for credentials, including dummy local API keys; never invent credential literals in tool arguments. Do not set PORT, HOST or PREVIEW_URL here. Previewhost injects the private port, HOST=127.0.0.1, and this service’s public browser alias. PREVIEW_URL is not the listen address. Only basic runtime variables such as PATH and HOME are inherited. previewhost does not load .env files; the application can.');
const jobArgv = argv.describe('Finite executable and argv, without shell expansion. Exit zero means success; nonzero exit, signal or timeout fails startup. No port is allocated. Report internal errors with a nonzero exit; Previewhost cannot detect swallowed errors.');
const probeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('http'), port: nameSchema.default('http'), path: readyPath, timeoutMs }),
  z.strictObject({ type: z.literal('tcp'), port: nameSchema, timeoutMs }),
  z.strictObject({ type: z.literal('command'), command: jobArgv, cwd: directory.optional(), env: serviceEnvironment.removeDefault().optional(), timeoutMs }),
]);
export type ReadinessProbe = z.output<typeof probeSchema>;
export type ProbeDescription = Exclude<ReadinessProbe, { type: 'command' }> | (Omit<Extract<ReadinessProbe, { type: 'command' }>, 'env'> & { envKeys?: string[]; bindings?: Record<string, Exclude<EnvironmentValue, string>> });
const nativeLifecycle = {
  ports: z.record(nameSchema, envKey).refine(value => Object.keys(value).length <= 8, 'At most eight ports per process.').optional()
    .describe('Named private ports and their injected environment keys. Commands default to {http: PORT}; workers default to no ports. Arguments may use {port:NAME}.'),
  ready: probeSchema.optional().describe('Explicit readiness probe. Commands otherwise use readyPath on the http port. Workers require a probe.'),
  critical: z.boolean().default(true).describe('After startup, a terminal failure of a critical process stops the environment.'),
  restart: z.strictObject({ mode: z.enum(['never', 'on-failure', 'always']), maxRestarts: z.number().int().min(0).max(10), backoffMs: z.number().int().min(0).max(30000) }).optional(),
  liveness: z.strictObject({ probe: probeSchema, intervalMs: z.number().int().min(100).max(60000), failureThreshold: z.number().int().min(1).max(10) }).optional(),
};
export const environmentServiceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('static'), directory, spa: z.boolean().default(false), dependsOn }),
  z.strictObject({ type: z.literal('command'), cwd: directory, command: argv, env: serviceEnvironment, readyPath, timeoutMs, dependsOn, ...nativeLifecycle }),
  z.strictObject({ type: z.literal('worker'), cwd: directory, command: argv, env: serviceEnvironment, dependsOn, ...nativeLifecycle, ready: probeSchema, overlap: z.enum(['exclusive', 'safe']).default('exclusive') }),
  z.strictObject({ type: z.literal('job'), cwd: directory, command: jobArgv, env: serviceEnvironment.describe('Job bindings use the same secret, input, service and public URL references as command services. PORT and HOST are reserved but are not injected into jobs. PREVIEW_URL is the environment numeric public origin; it may still serve the old application during replacement.'), dependsOn,
    timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
    run: z.enum(['always', 'once']).default('always').describe('always: run on each start/replacement; use repeatable migrations. once: run once per retained environment, requiring a managed database dependency. Success is retained by job name. Failed or interrupted runs require an explicit rerun or data deletion; writes are never rolled back by Previewhost.'),
  }),
  z.strictObject({ type: z.literal('attach'), url: z.string().max(4096).optional(), check: z.boolean().default(true), readyPath, timeoutMs, dependsOn }),
  z.strictObject({ type: z.literal('preview'), name: nameSchema, service: nameSchema.optional(), check: z.boolean().default(true), readyPath, timeoutMs, dependsOn }),
  z.strictObject({ type: z.literal('external-tcp'), host: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'), port: z.number().int().min(1).max(65535).optional(), check: z.boolean().default(true), timeoutMs, dependsOn }),
  z.strictObject({ type: z.literal('postgres') }),
  z.strictObject({ type: z.literal('redis') }),
  z.strictObject({ type: z.literal('external-postgres'), url: scalarValueSchema.optional(), check: z.boolean().default(true), timeoutMs }),
  z.strictObject({ type: z.literal('external-redis'), url: scalarValueSchema.optional(), check: z.boolean().default(true), timeoutMs }),
]);
export const dependencyBindingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('attach'), url: z.string().max(4096) }),
  z.strictObject({ type: z.literal('preview'), name: nameSchema, service: nameSchema.optional() }),
  z.strictObject({ type: z.literal('external-tcp'), host: z.enum(['127.0.0.1', 'localhost']), port: z.number().int().min(1).max(65535) }),
  z.strictObject({ type: z.literal('external-postgres'), url: z.strictObject({ secret: secretIdSchema }) }),
  z.strictObject({ type: z.literal('external-redis'), url: z.strictObject({ secret: secretIdSchema }) }),
]);
export type DependencyBinding = z.output<typeof dependencyBindingSchema>;

const environmentSpecSchema = z.strictObject({
  name: nameSchema, type: z.literal('environment'), primary: nameSchema.describe('HTTP service reached through the environment’s numeric public URL.'),
  routes: z.record(nameSchema, z.strictObject({ service: nameSchema, port: nameSchema })).refine(value => Object.keys(value).length <= 16).optional().describe('Additional HTTP browser routes for named command ports.'),
  services: z.record(nameSchema, environmentServiceSchema)
    .refine((services) => Object.keys(services).length >= 1 && Object.keys(services).length <= limits.environmentServices,
      `An environment needs between 1 and ${limits.environmentServices} services.`)
    .refine((services) => Object.values(services).filter((service) => service.type === 'postgres' || service.type === 'redis').length <= limits.environmentDatabases,
      `An environment supports at most ${limits.environmentDatabases} owned databases.`),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000)
    .describe('Overall environment startup deadline in milliseconds, across dependencies and service startup. Default 60000; maximum 600000. Individual service deadlines also apply.'),
});

const composePort = z.number().int().min(1).max(65535);
const composeSpecSchema = z.strictObject({
  name: nameSchema, type: z.literal('compose'), cwd: directory,
  files: z.array(z.string().min(1).max(4096)).min(1).max(8),
  profiles: z.array(nameSchema).max(16).default([]),
  rootServices: z.array(nameSchema).min(1).max(16),
  services: z.array(z.strictObject({
    id: nameSchema,
    ports: z.record(nameSchema, z.strictObject({ target: composePort })).refine(value => Object.keys(value).length <= 8),
    ready: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('http'), port: nameSchema, path: readyPath, timeoutMs }),
      z.strictObject({ type: z.literal('tcp'), port: nameSchema, timeoutMs }),
    ]).optional(),
  })).min(1).max(16),
  primary: z.strictObject({ service: nameSchema, port: nameSchema }),
  routes: z.record(nameSchema, z.strictObject({ service: nameSchema, port: nameSchema })).refine(value => Object.keys(value).length <= 16).default({}).describe('Additional browser HTTP routes. Private TCP ports are not exposed through the HTTP gateway.'),
  timeoutMs: z.number().int().min(100).max(600000).default(120000),
});
export type ComposeSpec = z.output<typeof composeSpecSchema>;

export const previewSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({ name: nameSchema, type: z.literal('static'), directory, spa: z.boolean().default(false) }),
  z.strictObject({
    name: nameSchema, type: z.literal('command'), cwd: directory,
    command: argv,
    env: envSchema, readyPath, timeoutMs,
  }),
  z.strictObject({ name: nameSchema, type: z.literal('attach'), url: z.string().max(4096), readyPath, timeoutMs }),
  environmentSpecSchema,
  composeSpecSchema,
]);
export type PreviewSpec = z.input<typeof previewSpecSchema>;
export type EffectiveSpec = z.output<typeof previewSpecSchema>;
export type CommandSpec = Extract<EffectiveSpec, { type: 'command' }>;
export type EnvironmentSpec = Extract<EffectiveSpec, { type: 'environment' }>;
export type EnvironmentService = z.output<typeof environmentServiceSchema>;
export type NativeServiceSpec = Extract<EnvironmentService, { type: 'command' | 'worker' }>;
export type OwnedDatabaseSpec = Extract<EnvironmentService, { type: 'postgres' | 'redis' }>;
export type EnvironmentValue = z.output<typeof environmentValueSchema>;
export interface ConfigurationBindingRow {
  service?: string;
  key: string;
  /** null keeps an existing literal undisclosed; symbolic references are safe to display. */
  value: Exclude<EnvironmentValue, string> | null;
}

export type ErrorCode =
  | 'INVALID_INPUT' | 'SOURCE_DENIED' | 'EXECUTION_DENIED' | 'ALREADY_EXISTS'
  | 'BUSY' | 'NOT_FOUND' | 'STALE_ATTEMPT' | 'ATTEMPT_EXPIRED' | 'UNSUPPORTED_PLATFORM'
  | 'START_FAILED' | 'SUPERVISOR_FAILED' | 'TIMEOUT' | 'CLEANUP_INCOMPLETE' | 'UNAUTHORIZED'
  | 'DAEMON_UNAVAILABLE' | 'CLOSED' | 'SECRET_REQUIRED' | 'SECRET_DENIED' | 'SECRET_STORE_UNAVAILABLE';
export interface Failure { code: ErrorCode; message: string; requirements?: SecretRequirement[]; outcome?: 'unknown' }
export interface SecretRequirement {
  id: string;
  selected: boolean;
  bindings: Array<{ service?: string; key: string }>;
}
export interface SecretSetupContext {
  mode: 'missing' | 'edit';
  name?: string;
  sources: string[];
  requirements: SecretRequirement[];
}
export interface SecretSetupStatus extends SecretSetupContext {
  id: string;
  state: 'pending' | 'saving' | 'complete' | 'partial' | 'canceled' | 'expired';
  expiresAt: string;
  browser: 'opened' | 'failed' | 'not-needed';
  saved: string[];
  alreadyPresent: string[];
  remaining: string[];
  error?: Failure;
  keystore?: import('./keystore.js').KeystoreStatus;
}
export interface SecretSetupApi {
  secretsSetup(spec: PreviewSpec, options?: { reopen?: boolean; signal?: AbortSignal }): Promise<SecretSetupStatus>;
  secretsStatus(id: string, options?: WaitOptions): Promise<SecretSetupStatus>;
  secretsEdit(id: string, options?: { signal?: AbortSignal }): Promise<SecretSetupStatus>;
}
export const secretRequestSchemas = {
  setup: z.strictObject({ spec: previewSpecSchema, reopen: z.boolean().optional() }),
  status: z.strictObject({ id: z.uuid(), timeoutMs: z.number().int().min(1).max(limits.secretWaitMs).optional()
    .describe('Wait up to 25000 milliseconds for completion, cancellation, or expiry. Omit for an immediate read. Canceling the wait leaves the private form open.') }),
  edit: z.strictObject({ id: secretIdSchema }),
};
export interface ServiceStatus {
  type: EnvironmentService['type'] | 'compose';
  state: 'waiting' | 'starting' | 'ready' | 'succeeded' | 'skipped' | 'failed' | 'canceled' | 'stopped';
  url?: string;
  browserUrl?: string;
  /** Dependencies still blocking this node during startup. Derived from the current attempt. */
  waitingFor?: string[];
  error?: Failure;
}
export interface DataStatus {
  resources: Array<{ name: string; type: OwnedDatabaseSpec['type'] | 'compose-volume' }>;
  running: boolean;
  cleanup?: Failure & { operation?: 'remove-credential' };
}
export interface AttemptSummary {
  id: string;
  type: EffectiveSpec['type'];
  state: 'starting' | 'ready' | 'failed' | 'canceled' | 'stopped' | 'cleanup-incomplete';
  startedAt: string;
  sources: string[];
  readyAt?: string;
  error?: Failure;
  services?: Record<string, ServiceStatus>;
}
export interface AttemptResult extends AttemptSummary { name: string; url?: string }
export interface PreviewStatus {
  name: string;
  url?: string;
  active?: AttemptSummary;
  candidate?: AttemptSummary;
  latest?: AttemptSummary;
  /** Recent attempts retained in this process, newest first. Logs expire after eviction or restart. */
  history?: AttemptSummary[];
  busy: boolean;
  cleanup?: Array<{ attemptId: string; error: Failure; sources: string[] }>;
  data?: DataStatus;
}
export interface PrerequisiteFinding {
  requirement: 'executable' | 'native-helper' | 'data-directory' | 'docker' | 'image';
  status: 'missing' | 'unverified';
  service?: string;
  message: string;
}
export interface PreviewDescription {
  compose?: import('./compose-inspection.js').ComposeInspection;
  /** File supplied with this attempt. Metadata only; it grants no filesystem access. */
  sourceFile?: string;
  /** Read-only observations, not startup validation or permission grants. */
  prerequisites?: PrerequisiteFinding[];
  spec: Omit<CommandSpec, 'env'> | Exclude<EffectiveSpec, CommandSpec | EnvironmentSpec> | {
    name: string; type: 'environment'; primary: string; timeoutMs: number; routes?: Record<string, { service: string; port: string }>;
    services: Record<string, {
      type: EnvironmentService['type']; cwd?: string; directory?: string; command?: string[];
      envKeys?: string[]; bindings?: Record<string, Exclude<EnvironmentValue, string>>;
      ports?: Record<string, string>; ready?: ProbeDescription; critical?: boolean; restart?: NativeServiceSpec['restart']; liveness?: Omit<NonNullable<NativeServiceSpec['liveness']>, 'probe'> & { probe: ProbeDescription }; overlap?: 'exclusive' | 'safe';
      readyPath?: string; timeoutMs?: number; spa?: boolean; dependsOn?: string[]; run?: 'always' | 'once';
      url?: ScalarValue; // External database literals are omitted.
      name?: string; service?: string; host?: string; port?: number; check?: boolean;
    }>;
  };
  envKeys: string[];
  secrets?: SecretRequirement[];
  source: 'caller-owned-live-directory' | 'external-http-server' | 'live-directories-and-dependencies';
  cleanup: 'owned-process-group' | 'owned-file-server' | 'proxy-connections-only' | 'owned-apps-and-containers-data-retained';
}
export interface LogOptions { source?: string; after?: number; maxBytes?: number }
export interface LogResult { name: string; attemptId: string; text: string; truncated: boolean; cursor: number }
export interface DeleteDataOptions { expected?: { attemptId: string | null; resources: DataStatus['resources'] } }
export interface WaitOptions { timeoutMs?: number; signal?: AbortSignal }
export interface StopOptions {
  afterEngineRestart?: boolean;
  /** Reject a stale management action before touching a different attempt. */
  expected?: { active: string | null; candidate: string | null; latest: string | null };
}
export interface StartOptions {
  expected?: StopOptions['expected'];
  /** Absolute input file path, when this declaration came from a configuration file. */
  sourceFile?: string;
}
export type ConfigureBindingsOptions =
  | { operation: 'inspect' }
  | { operation: 'save' }
  | { operation: 'apply'; expected: NonNullable<StopOptions['expected']> }
  | { operation: 'secrets'; reopen?: boolean };
export interface ConfigurationBindingsInspection {
  description: PreviewDescription;
  bindings: ConfigurationBindingRow[];
  inspection?: { prerequisites?: PrerequisiteFinding[]; error?: Failure };
}
export type ConfigureBindingsResult<T extends ConfigureBindingsOptions = ConfigureBindingsOptions> =
  T extends { operation: 'inspect' } ? ConfigurationBindingsInspection :
  T extends { operation: 'apply' } ? PreviewStatus :
  T extends { operation: 'secrets' } ? SecretSetupStatus : { file: string; externalSources: string[] };
export type SecretSetupSummary = Pick<SecretSetupStatus, 'id' | 'name' | 'mode' | 'state' | 'browser' | 'expiresAt'>;
export interface PreviewManagementApi {
  remove(name?: string, attemptId?: string | null): Promise<void>;
  describe(name: string, attemptId: string): Promise<PreviewDescription>;
  startAgain(name: string, attemptId: string): Promise<PreviewStatus>;
  saveConfiguration(name: string, attemptId: string): Promise<{ file: string; externalSources: string[] }>;
  configureBindings<T extends ConfigureBindingsOptions>(name: string, attemptId: string, changes: ConfigurationBindingChange[], options: T,
    request?: { signal?: AbortSignal }): Promise<ConfigureBindingsResult<T>>;
  secretsList(): Promise<SecretSetupSummary[]>;
  secretsOpen(id: string, options?: { signal?: AbortSignal }): Promise<SecretSetupStatus>;
}
export interface PreviewApi {
  inspect(spec: PreviewSpec): Promise<PreviewDescription>;
  start(spec: PreviewSpec, options?: StartOptions): Promise<PreviewStatus>;
  replace(name: string, spec: PreviewSpec, options?: StartOptions): Promise<PreviewStatus>;
  list(): Promise<PreviewStatus[]>;
  get(name: string): Promise<PreviewStatus>;
  wait(name: string, attemptId: string, options?: WaitOptions): Promise<AttemptResult>;
  logs(name: string, attemptId?: string, options?: LogOptions): Promise<LogResult>;
  cancel(name: string, attemptId: string): Promise<PreviewStatus>;
  stop(name: string, options?: StopOptions): Promise<PreviewStatus>;
  deleteData(name: string, options?: DeleteDataOptions): Promise<PreviewStatus>;
  rerunJob(name: string, attemptId: string, job: string): Promise<PreviewStatus>;
}
export type AuthorizationRequest = (
  | { operation: 'allow-sources'; directories: string[] }
  | { operation: 'start'; spec: EffectiveSpec; rerunJob?: string }
  | { operation: 'replace'; spec: EffectiveSpec }
  | { operation: 'delete-data'; name: string; resources: DataStatus['resources'] }
  | { operation: 'recover-data'; name: string; resources: DataStatus['resources'] }
  | { operation: 'secrets-setup'; mode: 'missing' | 'edit'; ids: string[]; spec?: EffectiveSpec }
) & { signal: AbortSignal };
export interface RuntimeOptions {
  allowedRoots: string[];
  inputs?: Record<string, string>;
  secretIds?: string[];
  dataDirectory?: string;
  /** Private profile directory. Omit to use the standalone Previewhost keystore. */
  keystoreDirectory?: string;
  /** Locked private directory for retained declarations and native cleanup receipts. Startup never replays commands. */
  stateDirectory?: string;
  /** Host-only launch settings for packaged embedders such as Electron. Never sent to application commands. */
  supervisor?: { executable?: string; module?: string; env?: Record<string, string> };
  dockerSocket?: string;
  authorize?: (request: AuthorizationRequest) => boolean | Promise<boolean>;
}

const attemptIdSchema = z.string().min(1).max(128).describe('Exact candidate attempt ID returned by start/replace or current status.');
const expectedSlotSchema = z.strictObject({
  active: attemptIdSchema.nullable(), candidate: attemptIdSchema.nullable(), latest: attemptIdSchema.nullable(),
});
const startOptionsShape = {
  expected: expectedSlotSchema.optional(),
  sourceFile: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'File paths cannot contain NUL.').optional(),
};
/** Argument containers shared by the HTTP and MCP adapters. */
export const requestSchemas = {
  inspect: z.strictObject({ spec: previewSpecSchema }),
  start: z.strictObject({ spec: previewSpecSchema, ...startOptionsShape }),
  replace: z.strictObject({ name: nameSchema, spec: previewSpecSchema, ...startOptionsShape }),
  list: z.strictObject({}),
  get: z.strictObject({ name: nameSchema }),
  wait: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema, timeoutMs: z.number().int().min(1).max(limits.waitMs).optional()
    .describe('Wait limit in milliseconds, default and maximum 30000. Timeout or canceling this wait leaves startup running; wait again or cancel the exact candidate.') }),
  logs: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema.optional(), maxBytes: z.number().int().min(4).max(limits.logBytes).optional(), source: nameSchema.optional(), after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }),
  cancel: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema }),
  stop: z.strictObject({ name: nameSchema, afterEngineRestart: z.boolean().optional(), expected: expectedSlotSchema.optional() }),
  describe: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema }),
  startAgain: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema }),
  saveConfiguration: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema }),
  configureBindings: z.strictObject({
    name: nameSchema, attemptId: attemptIdSchema,
    changes: z.array(configurationBindingChangeSchema).max(128 * limits.environmentServices),
    options: z.discriminatedUnion('operation', [
      z.strictObject({ operation: z.literal('inspect') }),
      z.strictObject({ operation: z.literal('save') }),
      z.strictObject({ operation: z.literal('apply'), expected: expectedSlotSchema }),
      z.strictObject({ operation: z.literal('secrets'), reopen: z.boolean().optional() }),
    ]),
  }),
  rerunJob: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema, job: nameSchema }),
  remove: z.strictObject({ name: nameSchema.optional(), attemptId: attemptIdSchema.nullable() }),
  deleteData: z.strictObject({ name: nameSchema, expected: z.strictObject({ attemptId: attemptIdSchema.nullable(), resources: z.array(z.strictObject({ name: nameSchema, type: z.enum(['postgres', 'redis', 'compose-volume']) })).min(1).max(64 + limits.environmentDatabases) }).optional() }),
};

export function needsExecution(spec: EffectiveSpec | PreviewDescription['spec']): boolean {
  return spec.type === 'compose' || spec.type === 'command' || spec.type === 'environment' && Object.values(spec.services).some((service) =>
    (service.type === 'command' || service.type === 'worker' || service.type === 'job') || service.type === 'postgres' || service.type === 'redis');
}
