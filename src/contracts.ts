import { z } from 'zod';

export const limits = {
  livePreviews: 32,
  terminalRecords: 128,
  logBytes: 65_536,
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
} as const;

export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const readyPath = z.string().max(2048).refine(
  (value) => value.startsWith('/') && !value.startsWith('//') && /^[\x21-\x7e]+$/.test(value) && !value.includes('#'),
  'Use a URL-encoded origin-relative readiness path without whitespace or a fragment.',
).default('/').describe('URL-encoded origin-relative readiness path. HTTP 200–399 headers count as ready; redirects are not followed and bodies are not checked.');
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000)
  .describe('Service readiness deadline in milliseconds, including any startup preparation. Default 30000; maximum 120000.');
const directory = z.string().min(1).max(4096)
  .describe('Existing live source directory, including uncommitted files. Use an absolute path in library/MCP calls; config-file paths resolve from that file.');
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const literal = z.string().max(4096).refine((value) => !value.includes('\0'), 'Values cannot contain NUL.');
export const secretIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, 'Use a secret name of 1–128 letters, numbers, dots, dashes, underscores or slashes.');
const inputReferenceSchema = z.strictObject({ fromEnv: envKey.describe('Environment input explicitly selected by the daemon owner; not an arbitrary client or shell variable.') });
export const scalarValueSchema = z.union([literal, inputReferenceSchema, z.strictObject({ secret: secretIdSchema })]);
export type ScalarValue = z.output<typeof scalarValueSchema>;
const argv = z.array(z.string().max(8192).refine((value) => !value.includes('\0'), 'Arguments cannot contain NUL.')).min(1).max(128)
  .refine((value) => value[0].length > 0, 'The executable cannot be empty.')
  .describe('Executable and argv, with no implicit shell: no $PORT expansion, pipes, redirects, or &&. Literal {port} is replaced with the allocated private port. Honor injected PORT and HOST=127.0.0.1 or pass explicit loopback/port flags; disable port fallback. Dependencies must exist or come from explicit project preparation. A command must stay running and serve HTTP, not only exit successfully.');
const envSchema = z.record(envKey, scalarValueSchema)
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'PORT, HOST and PREVIEW_URL are reserved.')
  .default({}).describe('Explicit command bindings. PORT, HOST and PREVIEW_URL are reserved: private port, 127.0.0.1, and numeric public origin. PREVIEW_URL is not the listen address. Only basic runtime variables such as PATH and HOME are inherited. previewd does not load .env files; the application can.');

export const environmentValueSchema = z.union([
  scalarValueSchema,
  z.strictObject({ service: nameSchema.describe('Wait for this service and use its candidate internal numeric HTTP URL or selected database connection URL. Adds a readiness dependency; cycles are invalid.') }),
  z.strictObject({ publicUrl: nameSchema.describe('Primary HTTP service only: numeric public origin. Adds no readiness dependency and can still reach the active application during replacement.') }),
  z.strictObject({ browserUrl: nameSchema.describe('Any HTTP service: public .localhost alias for browser requests. Adds no readiness dependency; native DNS resolution and candidate readiness are not guaranteed. During replacement it can still reach the active application.') }),
]);
const serviceEnvironment = z.record(envKey, environmentValueSchema)
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'PORT, HOST and PREVIEW_URL are reserved.')
  .default({}).describe('Explicit command bindings. PORT, HOST and PREVIEW_URL are reserved: private port, 127.0.0.1, and this service’s public browser alias. PREVIEW_URL is not the listen address. Only basic runtime variables such as PATH and HOME are inherited. previewd does not load .env files; the application can.');
export const environmentServiceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('static'), directory, spa: z.boolean().default(false) }),
  z.strictObject({ type: z.literal('command'), cwd: directory, command: argv, env: serviceEnvironment, readyPath, timeoutMs }),
  z.strictObject({ type: z.literal('attach'), url: z.string().max(4096), readyPath, timeoutMs }),
  z.strictObject({ type: z.literal('postgres') }),
  z.strictObject({ type: z.literal('redis') }),
  z.strictObject({ type: z.literal('external-postgres'), url: scalarValueSchema, timeoutMs }),
  z.strictObject({ type: z.literal('external-redis'), url: scalarValueSchema, timeoutMs }),
]);
const environmentSpecSchema = z.strictObject({
  name: nameSchema, type: z.literal('environment'), primary: nameSchema.describe('HTTP service reached through the environment’s numeric public URL.'),
  services: z.record(nameSchema, environmentServiceSchema)
    .refine((services) => Object.keys(services).length >= 1 && Object.keys(services).length <= limits.environmentServices,
      `An environment needs between 1 and ${limits.environmentServices} services.`)
    .refine((services) => Object.values(services).filter((service) => service.type === 'postgres' || service.type === 'redis').length <= limits.environmentDatabases,
      `An environment supports at most ${limits.environmentDatabases} owned databases.`),
  timeoutMs: timeoutMs.removeDefault().default(60_000)
    .describe('Overall environment startup deadline in milliseconds, across dependencies and service startup. Default 60000; maximum 120000. Individual service deadlines also apply.'),
});

export const previewSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({ name: nameSchema, type: z.literal('static'), directory, spa: z.boolean().default(false) }),
  z.strictObject({
    name: nameSchema, type: z.literal('command'), cwd: directory,
    command: argv,
    env: envSchema, readyPath, timeoutMs,
  }),
  z.strictObject({ name: nameSchema, type: z.literal('attach'), url: z.string().max(4096), readyPath, timeoutMs }),
  environmentSpecSchema,
]);
export type PreviewSpec = z.input<typeof previewSpecSchema>;
export type EffectiveSpec = z.output<typeof previewSpecSchema>;
export type CommandSpec = Extract<EffectiveSpec, { type: 'command' }>;
export type EnvironmentSpec = Extract<EffectiveSpec, { type: 'environment' }>;
export type EnvironmentService = z.output<typeof environmentServiceSchema>;
export type OwnedDatabaseSpec = Extract<EnvironmentService, { type: 'postgres' | 'redis' }>;
export type EnvironmentValue = z.output<typeof environmentValueSchema>;

export type ErrorCode =
  | 'INVALID_INPUT' | 'SOURCE_DENIED' | 'EXECUTION_DENIED' | 'ALREADY_EXISTS'
  | 'BUSY' | 'NOT_FOUND' | 'STALE_ATTEMPT' | 'ATTEMPT_EXPIRED' | 'UNSUPPORTED_PLATFORM'
  | 'START_FAILED' | 'TIMEOUT' | 'CLEANUP_INCOMPLETE' | 'UNAUTHORIZED'
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
}
export interface SecretSetupApi {
  secretsSetup(spec: PreviewSpec, options?: { reopen?: boolean; signal?: AbortSignal }): Promise<SecretSetupStatus>;
  secretsStatus(id: string): Promise<SecretSetupStatus>;
  secretsEdit(id: string, options?: { signal?: AbortSignal }): Promise<SecretSetupStatus>;
}
export const secretRequestSchemas = {
  setup: z.strictObject({ spec: previewSpecSchema, reopen: z.boolean().optional() }),
  status: z.strictObject({ id: z.uuid() }),
  edit: z.strictObject({ id: secretIdSchema }),
};
export interface ServiceStatus {
  type: EnvironmentService['type'];
  state: 'waiting' | 'starting' | 'ready' | 'failed' | 'stopped';
  url?: string;
  browserUrl?: string;
  error?: Failure;
}
export interface DataStatus {
  resources: Array<{ name: string; type: OwnedDatabaseSpec['type'] }>;
  running: boolean;
  cleanup?: Failure & { operation?: 'remove-credential' };
}
export interface AttemptSummary {
  id: string;
  type: EffectiveSpec['type'];
  state: 'starting' | 'ready' | 'failed' | 'canceled' | 'stopped' | 'cleanup-incomplete';
  startedAt: string;
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
  busy: boolean;
  cleanup?: Array<{ attemptId: string; error: Failure }>;
  data?: DataStatus;
}
export interface PreviewDescription {
  spec: Omit<CommandSpec, 'env'> | Exclude<EffectiveSpec, CommandSpec | EnvironmentSpec> | {
    name: string; type: 'environment'; primary: string; timeoutMs: number;
    services: Record<string, {
      type: EnvironmentService['type']; cwd?: string; directory?: string; command?: string[];
      envKeys?: string[]; bindings?: Record<string, Exclude<EnvironmentValue, string>>;
      readyPath?: string; timeoutMs?: number; spa?: boolean;
      url?: ScalarValue; // External database literals are omitted.
    }>;
  };
  envKeys: string[];
  secrets?: SecretRequirement[];
  source: 'caller-owned-live-directory' | 'external-http-server' | 'live-directories-and-dependencies';
  cleanup: 'owned-process-group' | 'owned-file-server' | 'proxy-connections-only' | 'owned-apps-and-containers-data-retained';
}
export interface LogResult { name: string; attemptId: string; text: string; truncated: boolean }
export interface WaitOptions { timeoutMs?: number; signal?: AbortSignal }
export interface StopOptions { afterEngineRestart?: boolean }
export interface PreviewApi {
  inspect(spec: PreviewSpec): Promise<PreviewDescription>;
  start(spec: PreviewSpec): Promise<PreviewStatus>;
  replace(name: string, spec: PreviewSpec): Promise<PreviewStatus>;
  list(): Promise<PreviewStatus[]>;
  get(name: string): Promise<PreviewStatus>;
  wait(name: string, attemptId: string, options?: WaitOptions): Promise<AttemptResult>;
  logs(name: string, attemptId?: string, maxBytes?: number): Promise<LogResult>;
  cancel(name: string, attemptId: string): Promise<PreviewStatus>;
  stop(name: string, options?: StopOptions): Promise<PreviewStatus>;
  deleteData(name: string): Promise<PreviewStatus>;
}
export type AuthorizationRequest = (
  | { operation: 'start'; spec: EffectiveSpec }
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
  dockerSocket?: string;
  authorize?: (request: AuthorizationRequest) => boolean | Promise<boolean>;
}

const attemptIdSchema = z.string().min(1).max(128).describe('Exact candidate attempt ID returned by start/replace or current status.');
/** Argument containers shared by the HTTP and MCP adapters. */
export const requestSchemas = {
  inspect: z.strictObject({ spec: previewSpecSchema }),
  start: z.strictObject({ spec: previewSpecSchema }),
  replace: z.strictObject({ name: nameSchema, spec: previewSpecSchema }),
  list: z.strictObject({}),
  get: z.strictObject({ name: nameSchema }),
  wait: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema, timeoutMs: z.number().int().min(1).max(limits.waitMs).optional()
    .describe('Wait limit in milliseconds, default and maximum 30000. Timeout or canceling this wait leaves startup running; wait again or cancel the exact candidate.') }),
  logs: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema.optional(), maxBytes: z.number().int().min(1).max(limits.logBytes).optional() }),
  cancel: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema }),
  stop: z.strictObject({ name: nameSchema, afterEngineRestart: z.boolean().optional() }),
  deleteData: z.strictObject({ name: nameSchema }),
};
