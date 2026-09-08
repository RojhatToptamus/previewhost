import fs from 'node:fs/promises';
import path from 'node:path';
import {
  previewSpecSchema, type EffectiveSpec, type EnvironmentService, type EnvironmentSpec,
  type PreviewDescription, type PreviewSpec, type ScalarValue,
} from './contracts.js';
import { PreviewError } from './errors.js';
import type { HttpTarget } from './resources.js';
import { validateDatabaseUrl } from './database-connections.js';

export function parseSpec(input: PreviewSpec): EffectiveSpec {
  const parsed = previewSpecSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PreviewError('INVALID_INPUT', `${issue.path.join('.') || 'spec'}: ${issue.message}`);
  }
  if (parsed.data.type === 'attach') attachmentTarget(parsed.data.url);
  if (parsed.data.type === 'environment') environmentDependencies(parsed.data);
  return parsed.data;
}

export function isWithin(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function canonicalDirectory(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new PreviewError('INVALID_INPUT', 'Use an absolute source directory.');
  try {
    const real = await fs.realpath(directory);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('Not a directory');
    return real;
  } catch {
    throw new PreviewError('INVALID_INPUT', 'The source directory does not exist or is not accessible.');
  }
}

export async function normalizeSpec(spec: EffectiveSpec, roots: string[], inputs: Readonly<Record<string, string>> = {}, privateDirectories: ReadonlySet<string> = new Set()): Promise<EffectiveSpec> {
  if (spec.type === 'attach') return spec;
  if (spec.type === 'environment') {
    const services = Object.fromEntries(await Promise.all(Object.entries(spec.services).map(async ([id, service]) => {
      if (service.type === 'command') {
        for (const value of Object.values(service.env)) {
          if (typeof value === 'object' && 'fromEnv' in value) resolveInput(value, inputs);
        }
      } else if (service.type === 'external-postgres' || service.type === 'external-redis') {
        if (typeof service.url === 'string' || 'fromEnv' in service.url) {
          validateDatabaseUrl(service.type === 'external-postgres' ? 'postgres' : 'redis', resolveInput(service.url, inputs));
        }
      }
      if (service.type !== 'static' && service.type !== 'command') return [id, service];
      const directory = await allowedDirectory(service.type === 'static' ? service.directory : service.cwd, roots);
      if (service.type === 'static') checkStaticSource(directory, privateDirectories);
      return [id, service.type === 'static' ? { ...service, directory } : { ...service, cwd: directory }];
    })));
    return { ...spec, services };
  }
  const directory = await allowedDirectory(spec.type === 'static' ? spec.directory : spec.cwd, roots);
  if (spec.type === 'static') checkStaticSource(directory, privateDirectories);
  else for (const value of Object.values(spec.env)) if (typeof value === 'object' && 'fromEnv' in value) resolveInput(value, inputs);
  return spec.type === 'static' ? { ...spec, directory } : { ...spec, cwd: directory };
}

function checkStaticSource(directory: string, privateDirectories: ReadonlySet<string>): void {
  if ([...privateDirectories].some((root) => isWithin(root, directory))) {
    throw new PreviewError('SOURCE_DENIED', 'An owner-private directory cannot be served as a static source.');
  }
}

async function allowedDirectory(input: string, roots: string[]): Promise<string> {
  const directory = await canonicalDirectory(input);
  if (!roots.some((root) => isWithin(root, directory))) {
    throw new PreviewError('SOURCE_DENIED', 'The source directory is outside the allowed roots.');
  }
  return directory;
}

export function describeSpec(spec: EffectiveSpec): PreviewDescription {
  if (spec.type === 'environment') {
    const envKeys: string[] = [];
    const services = Object.fromEntries(Object.entries(spec.services).map(([id, service]) => {
      if (service.type === 'command') {
        const { env, ...publicService } = service;
        const keys = Object.keys(env).sort();
        envKeys.push(...keys.map((key) => `${id}.${key}`));
        return [id, { ...publicService, envKeys: keys,
          bindings: Object.fromEntries(Object.entries(env).filter((entry) => typeof entry[1] !== 'string')) }];
      }
      if (service.type === 'external-postgres' || service.type === 'external-redis') {
        return [id, { type: service.type, timeoutMs: service.timeoutMs,
          ...(typeof service.url === 'object' ? { url: { ...service.url } } : {}) }];
      }
      return [id, { ...service }];
    }));
    return {
      spec: { name: spec.name, type: 'environment', primary: spec.primary, timeoutMs: spec.timeoutMs, services },
      envKeys: envKeys.sort(), source: 'live-directories-and-dependencies', cleanup: 'owned-apps-and-containers-data-retained',
    };
  }
  if (spec.type === 'command') {
    const { env, ...publicSpec } = spec;
    return { spec: publicSpec, envKeys: Object.keys(env).sort(), source: 'caller-owned-live-directory', cleanup: 'owned-process-group' };
  }
  return {
    spec: { ...spec }, envKeys: [],
    source: spec.type === 'static' ? 'caller-owned-live-directory' : 'external-http-server',
    cleanup: spec.type === 'static' ? 'owned-file-server' : 'proxy-connections-only',
  };
}

export function isHttpService(service: EnvironmentService): boolean {
  return service.type === 'static' || service.type === 'command' || service.type === 'attach';
}

export function browserHostname(name: string, service: string): string {
  const label = `${name}--${service}`;
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new PreviewError('INVALID_INPUT', 'The combined browser label must fit 63 characters and end with a letter or digit.');
  }
  return `${label}.localhost`;
}

/** Only connections that require a ready service create startup edges. */
export function environmentDependencies(spec: EnvironmentSpec): Map<string, string[]> {
  if (!Object.hasOwn(spec.services, spec.primary) || !isHttpService(spec.services[spec.primary])) {
    throw new PreviewError('INVALID_INPUT', 'The primary service must name an HTTP command, static server, or attachment.');
  }
  const graph = new Map<string, string[]>();
  for (const [id, service] of Object.entries(spec.services)) {
    if (isHttpService(service)) browserHostname(spec.name, id);
    if (service.type === 'attach') attachmentTarget(service.url);
    const dependencies = new Set<string>();
    if (service.type === 'command') {
      for (const value of Object.values(service.env)) {
        if (typeof value === 'string' || 'fromEnv' in value || 'secret' in value) continue;
        const target = 'service' in value ? value.service : 'publicUrl' in value ? value.publicUrl : value.browserUrl;
        if (!Object.hasOwn(spec.services, target)) throw new PreviewError('INVALID_INPUT', `Service ${id} refers to missing service ${target}.`);
        if ('service' in value) dependencies.add(target);
        else if (!isHttpService(spec.services[target])) throw new PreviewError('INVALID_INPUT', `Service ${target} has no public HTTP URL.`);
        else if ('publicUrl' in value && target !== spec.primary) {
          throw new PreviewError('INVALID_INPUT', 'Only the primary service has a numeric public URL. Use browserUrl for another public service.');
        }
      }
    }
    graph.set(id, [...dependencies]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new PreviewError('INVALID_INPUT', `The readiness dependencies contain a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id)!) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return graph;
}

export function resolveInput(value: ScalarValue, inputs: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>> = {}): string {
  if (typeof value === 'string') return value;
  if ('secret' in value) {
    if (!Object.hasOwn(secrets, value.secret)) throw new PreviewError('SECRET_REQUIRED', 'A required secret was not resolved.');
    return secrets[value.secret];
  }
  if (!Object.hasOwn(inputs, value.fromEnv)) throw new PreviewError('INVALID_INPUT', `Required owner input ${value.fromEnv} was not supplied.`);
  return inputs[value.fromEnv];
}

export function validateResolvedInputs(spec: EffectiveSpec, inputs: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>): void {
  if (spec.type === 'command') validateEnvironmentSize(Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, resolveInput(value, inputs, secrets)])));
  if (spec.type === 'environment') for (const service of Object.values(spec.services)) {
    if (service.type === 'external-postgres' || service.type === 'external-redis') {
      validateDatabaseUrl(service.type === 'external-postgres' ? 'postgres' : 'redis', resolveInput(service.url, inputs, secrets));
    } else if (service.type === 'command') {
      const values = Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key,
        typeof value === 'string' || 'fromEnv' in value || 'secret' in value ? resolveInput(value, inputs, secrets) : '']));
      validateEnvironmentSize(values);
    }
  }
}

export function validateEnvironmentSize(values: Record<string, string>): void {
  if (Buffer.byteLength(JSON.stringify(values)) > 65_536) throw new PreviewError('INVALID_INPUT', 'The resolved service environment exceeds 64 KiB.');
}

export function sameSources(before: EffectiveSpec, after: EffectiveSpec): boolean {
  if (before.type !== after.type) return false;
  if (before.type === 'command' && after.type === 'command') return before.cwd === after.cwd;
  if (before.type === 'static' && after.type === 'static') return before.directory === after.directory;
  if (before.type === 'environment' && after.type === 'environment') {
    return Object.entries(before.services).every(([id, service]) => {
      const checked = after.services[id];
      return service.type === 'command' ? checked?.type === 'command' && service.cwd === checked.cwd :
        service.type === 'static' ? checked?.type === 'static' && service.directory === checked.directory : true;
    });
  }
  return true;
}

export function attachmentTarget(input: string): HttpTarget {
  const match = /^http:\/\/(127\.0\.0\.1|localhost|[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost):([0-9]+)\/?$/.exec(input);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new PreviewError('INVALID_INPUT', 'Attach requires http://127.0.0.1:PORT/, localhost:PORT, or a single .localhost label. Paths, credentials, IPv6 and remote hosts are not supported.');
  }
  const port = Number(match[2]);
  return { port, hostHeader: `${match[1]}:${port}` };
}
