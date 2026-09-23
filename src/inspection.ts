import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { limits, type EffectiveSpec, type PrerequisiteFinding, type PreviewSpec, type RuntimeOptions } from './contracts.js';
import { Docker, defaultDockerEndpoint } from './docker.js';
import { PreviewError } from './errors.js';
import { nativeTools } from './native.js';
import { requireSupportedPlatform } from './private-files.js';
import { canonicalDirectory, describeSpec, environmentDependencies, isWithin, normalizeSpec, parseSpec } from './spec.js';
import { secretRequirements, validateSecretId } from './secrets.js';

/** Shared validation for owner creation and offline inspection. Neither starts resources. */
export async function runtimeContext(options: RuntimeOptions) {
  requireSupportedPlatform();
  if (!options || !Array.isArray(options.allowedRoots) || options.allowedRoots.length < 1 || options.allowedRoots.length > 32) {
    throw new PreviewError('INVALID_INPUT', 'Supply between 1 and 32 allowed source roots.');
  }
  const roots = [...new Set(await Promise.all(options.allowedRoots.map(canonicalDirectory)))];
  const inputs = { ...options.inputs };
  if (options.secretIds !== undefined && (!Array.isArray(options.secretIds) || options.secretIds.length > limits.secrets)) {
    throw new PreviewError('INVALID_INPUT', `Select at most ${limits.secrets} secret names.`);
  }
  for (const id of options.secretIds ?? []) validateSecretId(id);
  const secretIds = new Set(options.secretIds ?? []);
  if (Object.keys(inputs).length > 128 || Object.entries(inputs).some(([key, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) {
    throw new PreviewError('INVALID_INPUT', 'Owner inputs must be at most 128 named strings of at most 4096 characters.');
  }
  if (options.dockerSocket && !options.dataDirectory) throw new PreviewError('INVALID_INPUT', 'dockerSocket requires a dataDirectory.');
  return { roots, inputs, secretIds };
}

/** Consume approved roots as identities; resolving them again would grant a replaced symlink target. */
export async function inspectPreviewSpec(input: PreviewSpec, context: {
  roots: string[]; inputs: Readonly<Record<string, string>>; secretIds: ReadonlySet<string>;
} & Pick<RuntimeOptions, 'dataDirectory' | 'dockerSocket'>, privateDirectories: ReadonlySet<string>) {
  const { roots, inputs, secretIds } = context;
  const spec = await normalizeSpec(parseSpec(input), roots, inputs, privateDirectories);
  const secrets = secretRequirements(spec, secretIds);
  const prerequisites = await inspectPrerequisites(spec, roots, context);
  return { ...describeSpec(spec), ...(secrets.length ? { secrets } : {}), ...(prerequisites.length ? { prerequisites } : {}) };
}

async function inspectPrerequisites(spec: EffectiveSpec, roots: string[], options: Pick<RuntimeOptions, 'dataDirectory' | 'dockerSocket'>): Promise<PrerequisiteFinding[]> {
  const findings: PrerequisiteFinding[] = [];
  const services = spec.type === 'environment' ? Object.entries(spec.services) : [[undefined, spec] as const];
  const graph = spec.type === 'environment' ? environmentDependencies(spec) : new Map<string, string[]>();
  function precedingJobs(id: string): string[] {
    const visited = new Set<string>();
    function visit(name: string) {
      for (const dependency of graph.get(name) ?? []) if (!visited.has(dependency)) {
        visited.add(dependency); visit(dependency);
      }
    }
    visit(id);
    return spec.type === 'environment' ? [...visited].filter(name => spec.services[name].type === 'job') : [];
  }
  const commands = services.filter(([, service]) => service.type === 'command' || service.type === 'job');
  for (const helper of commands.length ? nativeTools() : []) {
    if (!await executableFile(helper)) findings.push({ requirement: 'native-helper', status: 'missing', message: `Install the system helper ${helper} before starting native commands.` });
  }
  for (const [service, command] of commands) {
    if (command.type !== 'command' && command.type !== 'job') continue;
    const scope = service ? { service } : {};
    const executable = command.command[0];
    const direct = isAbsolute(executable) || executable.includes('/') || process.platform === 'win32' && executable.includes('\\');
    // Do not resolve PATH bindings: they may contain a private input or secret.
    if (!direct && Object.keys(command.env).some(key => process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')) {
      findings.push({ ...scope, requirement: 'executable', status: 'unverified', message: 'Executable lookup uses an explicit PATH binding. Verify it during startup; inspection does not resolve that binding.' });
      continue;
    }
    const locations = (process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin')).split(delimiter).map(path => resolve(command.cwd, path));
    const candidates = direct ? [resolve(command.cwd, executable)] : locations.map(directory => resolve(directory, executable));
    if (process.platform === 'win32' && !/\.exe$/i.test(executable)) candidates.push(...candidates.map(path => `${path}.exe`));
    let checked = false;
    let found = false;
    for (const candidate of candidates) {
      // Source-supplied paths cannot use inspect as an arbitrary filesystem probe.
      const allowed = !direct || candidate === process.execPath || locations.includes(dirname(candidate)) || roots.some(root => isWithin(root, candidate));
      if (!allowed) continue;
      const canonical = await realpath(candidate).catch(() => undefined);
      if (direct && canonical && canonical !== process.execPath && !locations.includes(dirname(canonical)) && !roots.some(root => isWithin(root, canonical))) continue;
      checked = true;
      if (canonical && await executableFile(canonical)) { found = true; break; }
    }
    if (found) continue;
    const jobs = service ? precedingJobs(service) : [];
    findings.push({ ...scope, requirement: 'executable', status: checked && !jobs.length ? 'missing' : 'unverified', message: !checked
      ? 'The executable is outside approved sources and the owner’s PATH. Its availability was not checked.'
      : jobs.length ? `Executable is not available yet. Check whether earlier jobs (${jobs.join(', ')}) prepare it.`
        : 'Executable is missing or cannot be executed. Install it or correct the command and owner PATH before startup.' });
  }
  const databases = services.flatMap(([, service]) => service.type === 'postgres' || service.type === 'redis' ? [service.type] : []);
  if (!databases.length) return findings;
  if (!options.dataDirectory) findings.push({ requirement: 'data-directory', status: 'missing', message: 'Managed databases require a private dataDirectory on the runtime, or --data-dir on serve. Automatic project owners supply one.' });
  let docker: Docker;
  const signal = AbortSignal.timeout(2000);
  try {
    docker = await Docker.connect(options.dockerSocket ?? defaultDockerEndpoint());
    await docker.engineId({ signal });
  } catch {
    findings.push({ requirement: 'docker', status: 'unverified', message: 'The configured local Docker Engine could not be reached. Start Docker or check the owner’s --docker-socket setting.' });
    return findings;
  }
  for (const type of new Set(databases)) {
    try { await docker.image(type, { signal }); }
    catch {
      findings.push({ requirement: 'image', status: 'unverified', message: `The local ${type === 'postgres' ? 'postgres:17-alpine' : 'redis:7-alpine'} image could not be verified. Install the image with Docker before startup.` });
    }
  }
  return findings;
}

async function executableFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() && await access(path, constants.X_OK).then(() => true); }
  catch { return false; }
}
