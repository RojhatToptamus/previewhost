import { limits, secretIdSchema, type EffectiveSpec, type SecretRequirement } from './contracts.js';
import { PreviewError, throwIfAborted } from './errors.js';
import { keychain, validateSecretValue, type KeychainOptions } from './keychain.js';

export function validateSecretId(id: unknown): asserts id is string {
  if (!secretIdSchema.safeParse(id).success) throw new PreviewError('INVALID_INPUT', 'Use a secret name of 1–128 letters, numbers, dots, dashes, underscores or slashes.');
}

/** Owner operations share this path with the local form. No value-read API is exported. */
export async function setSecret(id: string, value: string, options: KeychainOptions = {}): Promise<void> {
  validateSecretId(id); validateSecretValue(value);
  if (await keychain.add('user', id, value, options)) return;
  if (!await keychain.update('user', id, value, options)) {
    throw new PreviewError('SECRET_REQUIRED', 'The entry was removed during the update. Retry set to create it.');
  }
}
export async function removeSecret(id: string, options: KeychainOptions = {}): Promise<void> {
  validateSecretId(id);
  await keychain.remove('user', id, options);
}
export async function listSecrets(options: KeychainOptions = {}): Promise<{ ids: string[]; truncated: boolean }> {
  return keychain.list(options);
}

export function secretRequirements(spec: EffectiveSpec, selected: ReadonlySet<string>): SecretRequirement[] {
  const required = new Map<string, SecretRequirement>();
  function add(value: unknown, key: string, service?: string) {
    if (!value || typeof value !== 'object' || !('secret' in value) || typeof value.secret !== 'string') return;
    const item = required.get(value.secret) ?? { id: value.secret, selected: selected.has(value.secret), bindings: [] };
    item.bindings.push({ ...(service ? { service } : {}), key });
    required.set(item.id, item);
  }
  if (spec.type === 'command') for (const [key, value] of Object.entries(spec.env)) add(value, key);
  if (spec.type === 'environment') for (const [id, service] of Object.entries(spec.services)) {
    if (service.type === 'command') for (const [key, value] of Object.entries(service.env)) add(value, key, id);
    else if (service.type === 'external-postgres' || service.type === 'external-redis') add(service.url, 'url', id);
  }
  if (required.size > limits.secrets) throw new PreviewError('INVALID_INPUT', `An attempt can use at most ${limits.secrets} distinct secrets.`);
  return [...required.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function requireSelected(requirements: SecretRequirement[]): void {
  if (requirements.some((item) => !item.selected)) {
    throw new PreviewError('SECRET_DENIED', 'The daemon owner must select the required secret names with --secret.', { requirements });
  }
}

/** Resolve each ID once and join every read before returning or failing. */
export async function resolveSecrets(requirements: SecretRequirement[], signal: AbortSignal): Promise<Record<string, string>> {
  requireSelected(requirements);
  const values: Record<string, string> = {};
  const absent: SecretRequirement[] = [];
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  let next = 0;
  let problem: unknown;
  await Promise.all(Array.from({ length: Math.min(limits.secretOperations, requirements.length) }, async () => {
    try {
      while (next < requirements.length) {
        throwIfAborted(combined);
        const item = requirements[next++];
        const value = await keychain.get('user', item.id, { signal: combined });
        if (value === undefined) absent.push(item);
        else values[item.id] = value;
      }
    } catch (error) { problem ??= error; stop.abort(); }
  }));
  if (problem) throw problem;
  throwIfAborted(signal);
  if (absent.length) throw new PreviewError('SECRET_REQUIRED', 'Required secrets are missing. Open private secret setup, then retry startup.',
    { requirements: absent.sort((a, b) => a.id.localeCompare(b.id)) });
  return values;
}
