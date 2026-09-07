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
} as const;

export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const readyPath = z.string().max(2048).refine(
  (value) => value.startsWith('/') && !value.startsWith('//') && /^[\x21-\x7e]+$/.test(value) && !value.includes('#'),
  'Use a URL-encoded origin-relative readiness path without whitespace or a fragment.',
).default('/');
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000);
const directory = z.string().min(1).max(4096);
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const literal = z.string().max(4096).refine((value) => !value.includes('\0'), 'Values cannot contain NUL.');
const argv = z.array(z.string().max(8192).refine((value) => !value.includes('\0'), 'Arguments cannot contain NUL.')).min(1).max(128)
  .refine((value) => value[0].length > 0, 'The executable cannot be empty.');
const envSchema = z.record(envKey, literal)
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'PORT, HOST and PREVIEW_URL are reserved.')
  .refine((env) => Object.values(env).every((value) => !value.includes('\0')), 'Environment values cannot contain NUL.')
  .default({});

const inputReferenceSchema = z.strictObject({ fromEnv: envKey });
export const environmentValueSchema = z.union([
  literal, inputReferenceSchema,
  z.strictObject({ service: nameSchema }),
  z.strictObject({ publicUrl: nameSchema }),
  z.strictObject({ browserUrl: nameSchema }),
]);
const serviceEnvironment = z.record(envKey, environmentValueSchema)
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'PORT, HOST and PREVIEW_URL are reserved.')
  .default({});
export const environmentServiceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('static'), directory, spa: z.boolean().default(false) }),
  z.strictObject({ type: z.literal('command'), cwd: directory, command: argv, env: serviceEnvironment, readyPath, timeoutMs }),
  z.strictObject({ type: z.literal('attach'), url: z.string().max(4096), readyPath, timeoutMs }),
  z.strictObject({ type: z.literal('postgres') }),
  z.strictObject({ type: z.literal('redis') }),
  z.strictObject({ type: z.literal('external-postgres'), url: z.union([literal, inputReferenceSchema]), timeoutMs }),
  z.strictObject({ type: z.literal('external-redis'), url: z.union([literal, inputReferenceSchema]), timeoutMs }),
]);
const environmentSpecSchema = z.strictObject({
  name: nameSchema, type: z.literal('environment'), primary: nameSchema,
  services: z.record(nameSchema, environmentServiceSchema)
    .refine((services) => Object.keys(services).length >= 1 && Object.keys(services).length <= limits.environmentServices,
      `An environment needs between 1 and ${limits.environmentServices} services.`)
    .refine((services) => Object.values(services).filter((service) => service.type === 'postgres' || service.type === 'redis').length <= limits.environmentDatabases,
      `An environment supports at most ${limits.environmentDatabases} owned databases.`),
  timeoutMs: timeoutMs.removeDefault().default(60_000),
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
  | 'DAEMON_UNAVAILABLE' | 'CLOSED';
export interface Failure { code: ErrorCode; message: string }
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
  cleanup?: Failure;
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
      url?: string | { fromEnv: string }; // External database literals are omitted.
    }>;
  };
  envKeys: string[];
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
) & { signal: AbortSignal };
export interface RuntimeOptions {
  allowedRoots: string[];
  inputs?: Record<string, string>;
  dataDirectory?: string;
  dockerSocket?: string;
  authorize?: (request: AuthorizationRequest) => boolean | Promise<boolean>;
}

const attemptIdSchema = z.string().min(1).max(128);
/** Argument containers shared by the HTTP and MCP adapters. */
export const requestSchemas = {
  inspect: z.strictObject({ spec: previewSpecSchema }),
  start: z.strictObject({ spec: previewSpecSchema }),
  replace: z.strictObject({ name: nameSchema, spec: previewSpecSchema }),
  list: z.strictObject({}),
  get: z.strictObject({ name: nameSchema }),
  wait: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema, timeoutMs: z.number().int().min(1).max(limits.waitMs).optional() }),
  logs: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema.optional(), maxBytes: z.number().int().min(1).max(limits.logBytes).optional() }),
  cancel: z.strictObject({ name: nameSchema, attemptId: attemptIdSchema }),
  stop: z.strictObject({ name: nameSchema, afterEngineRestart: z.boolean().optional() }),
  deleteData: z.strictObject({ name: nameSchema }),
};
