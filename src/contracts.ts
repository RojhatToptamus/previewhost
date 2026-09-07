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
} as const;

export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const readyPath = z.string().max(2048).refine(
  (value) => value.startsWith('/') && !value.startsWith('//') && /^[\x21-\x7e]+$/.test(value) && !value.includes('#'),
  'Use a URL-encoded origin-relative readiness path without whitespace or a fragment.',
).default('/');
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000);
const directory = z.string().min(1).max(4096);
const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(4096))
  .refine((env) => Object.keys(env).length <= 128 && JSON.stringify(env).length <= 65_536, 'Environment is too large.')
  .refine((env) => !['PORT', 'HOST', 'PREVIEW_URL'].some((key) => Object.hasOwn(env, key)), 'PORT, HOST and PREVIEW_URL are reserved.')
  .refine((env) => Object.values(env).every((value) => !value.includes('\0')), 'Environment values cannot contain NUL.')
  .default({});

export const previewSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({ name: nameSchema, type: z.literal('static'), directory, spa: z.boolean().default(false) }),
  z.strictObject({
    name: nameSchema, type: z.literal('command'), cwd: directory,
    command: z.array(z.string().max(8192).refine((value) => !value.includes('\0'), 'Arguments cannot contain NUL.')).min(1).max(128)
      .refine((value) => value[0].length > 0, 'The executable cannot be empty.'),
    env: envSchema, readyPath, timeoutMs,
  }),
  z.strictObject({ name: nameSchema, type: z.literal('attach'), url: z.string().max(4096), readyPath, timeoutMs }),
]);
export type PreviewSpec = z.input<typeof previewSpecSchema>;
export type EffectiveSpec = z.output<typeof previewSpecSchema>;
export type CommandSpec = Extract<EffectiveSpec, { type: 'command' }>;

export type ErrorCode =
  | 'INVALID_INPUT' | 'SOURCE_DENIED' | 'EXECUTION_DENIED' | 'ALREADY_EXISTS'
  | 'BUSY' | 'NOT_FOUND' | 'STALE_ATTEMPT' | 'ATTEMPT_EXPIRED' | 'UNSUPPORTED_PLATFORM'
  | 'START_FAILED' | 'TIMEOUT' | 'CLEANUP_INCOMPLETE' | 'UNAUTHORIZED'
  | 'DAEMON_UNAVAILABLE' | 'CLOSED';
export interface Failure { code: ErrorCode; message: string }
export interface AttemptSummary {
  id: string;
  type: EffectiveSpec['type'];
  state: 'starting' | 'ready' | 'failed' | 'canceled' | 'stopped' | 'cleanup-incomplete';
  startedAt: string;
  readyAt?: string;
  error?: Failure;
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
}
export interface PreviewDescription {
  spec: Omit<CommandSpec, 'env'> | Exclude<EffectiveSpec, CommandSpec>;
  envKeys: string[];
  source: 'caller-owned-live-directory' | 'external-http-server';
  cleanup: 'owned-process-group' | 'owned-file-server' | 'proxy-connections-only';
}
export interface LogResult { name: string; attemptId: string; text: string; truncated: boolean }
export interface WaitOptions { timeoutMs?: number; signal?: AbortSignal }
export interface PreviewApi {
  inspect(spec: PreviewSpec): Promise<PreviewDescription>;
  start(spec: PreviewSpec): Promise<PreviewStatus>;
  replace(name: string, spec: PreviewSpec): Promise<PreviewStatus>;
  list(): Promise<PreviewStatus[]>;
  get(name: string): Promise<PreviewStatus>;
  wait(name: string, attemptId: string, options?: WaitOptions): Promise<AttemptResult>;
  logs(name: string, attemptId?: string, maxBytes?: number): Promise<LogResult>;
  cancel(name: string, attemptId: string): Promise<PreviewStatus>;
  stop(name: string): Promise<PreviewStatus>;
}
export interface RuntimeOptions {
  allowedRoots: string[];
  authorize?: (request: {
    operation: 'start' | 'replace'; spec: EffectiveSpec; signal: AbortSignal;
  }) => boolean | Promise<boolean>;
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
  stop: z.strictObject({ name: nameSchema }),
};
