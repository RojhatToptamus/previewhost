import fs from 'node:fs/promises';
import path from 'node:path';
import { previewSpecSchema, type EffectiveSpec, type PreviewDescription, type PreviewSpec } from './contracts.js';
import { PreviewError } from './errors.js';
import type { HttpTarget } from './resources.js';

export function parseSpec(input: PreviewSpec): EffectiveSpec {
  const parsed = previewSpecSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PreviewError('INVALID_INPUT', `${issue.path.join('.') || 'spec'}: ${issue.message}`);
  }
  if (parsed.data.type === 'attach') attachmentTarget(parsed.data.url);
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

export async function normalizeSpec(spec: EffectiveSpec, roots: string[]): Promise<EffectiveSpec> {
  if (spec.type === 'attach') return spec;
  const directory = await canonicalDirectory(spec.type === 'static' ? spec.directory : spec.cwd);
  if (!roots.some((root) => isWithin(root, directory))) {
    throw new PreviewError('SOURCE_DENIED', 'The source directory is outside the allowed roots.');
  }
  return spec.type === 'static' ? { ...spec, directory } : { ...spec, cwd: directory };
}

export function describeSpec(spec: EffectiveSpec): PreviewDescription {
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

export function attachmentTarget(input: string): HttpTarget {
  const match = /^http:\/\/(127\.0\.0\.1|localhost|[a-z](?:[a-z0-9-]{0,46}[a-z0-9])?\.localhost):([0-9]+)\/?$/.exec(input);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new PreviewError('INVALID_INPUT', 'Attach requires http://127.0.0.1:PORT/, localhost:PORT, or a single .localhost label. Paths, credentials, IPv6 and remote hosts are not supported.');
  }
  const port = Number(match[2]);
  return { port, hostHeader: `${match[1]}:${port}` };
}
