import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ComposeSpec, RuntimeOptions } from './contracts.js';
import { PreviewError } from './errors.js';
import { runNativeJob, startNative, type NativeOwnership } from './native.js';
import type { Resource } from './resources.js';

/** Compose reads and build commands use an explicit local engine and a private, empty CLI home. */
export class ComposeCli {
  private constructor(readonly directory: string, private readonly socket: string) {}

  static async create(parent: string, socket: string): Promise<ComposeCli> {
    const directory = await mkdtemp(join(parent, 'command-'));
    await writeFile(join(directory, 'empty.env'), '', { mode: 0o600 });
    // Docker Desktop installs its plugin through this per-user link. Read only the executable path, never the user's Docker configuration or credentials.
    const plugin = await realpath(join(homedir(), '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-compose.exe' : 'docker-compose')).catch(() => undefined);
    if (plugin) await writeFile(join(directory, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: [dirname(plugin)] }), { mode: 0o600 });
    return new ComposeCli(directory, socket);
  }

  private environment(): Record<string, string> {
    const env: Record<string, string> = { HOME: this.directory, TMPDIR: this.directory, COMPOSE_DISABLE_ENV_FILE: '1', COMPOSE_ANSI: 'never', COMPOSE_MENU: '0',
      COMPOSE_EXPERIMENTAL: '0', PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
    // Docker discovers its system Compose plugin under ProgramFiles on Windows.
    if (process.platform === 'win32' && process.env.ProgramFiles) env.ProgramFiles = process.env.ProgramFiles;
    return env;
  }

  private dockerArgs(): string[] {
    const endpoint = process.platform === 'win32' ? this.socket.replace(/^\\\\\.\\pipe\\/, 'npipe:////./pipe/') : `unix://${this.socket}`;
    return ['--config', this.directory, '--host', endpoint, 'compose'];
  }

  private base(spec: ComposeSpec, project: string, files: string[]): string[] {
    return [...this.dockerArgs(), '-p', project, '--project-directory', spec.cwd, '--env-file', join(this.directory, 'empty.env'),
      ...files.flatMap(file => ['-f', file]), ...spec.profiles.flatMap(profile => ['--profile', profile])];
  }

  private read(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('docker', args, { cwd, env: this.environment(), timeout: 20000, maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true },
        (error, stdout) => error ? reject(new PreviewError('START_FAILED', 'Docker Compose inspection failed. Check the local CLI and configuration. Command output is private.')) : resolve(stdout));
    });
  }

  async probe(signal: AbortSignal): Promise<string> {
    const results = await Promise.allSettled([
      this.read([...this.dockerArgs(), 'version', '--short'], this.directory, signal),
      this.read([...this.dockerArgs(), 'config', '--help'], this.directory, signal),
      this.read([...this.dockerArgs(), 'up', '--help'], this.directory, signal),
    ]);
    const [versionResult, configResult, upResult] = results;
    if (versionResult.status === 'rejected') throw versionResult.reason;
    if (configResult.status === 'rejected') throw configResult.reason;
    if (upResult.status === 'rejected') throw upResult.reason;
    const [version, config, up] = [versionResult.value, configResult.value, upResult.value];
    if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\s*$/.test(version) ||
        !['--no-env-resolution', '--no-path-resolution'].every(flag => config.includes(flag)) ||
        !['--wait', '--wait-timeout', '--pull', '--no-build'].every(flag => up.includes(flag))) {
      throw new PreviewError('START_FAILED', 'Install Docker Compose with config normalization and bounded up/wait support.');
    }
    return version.trim().replace(/^v/, '');
  }

  config(spec: ComposeSpec, materialized: boolean, signal: AbortSignal): Promise<string> {
    return this.read([...this.base(spec, 'previewhost-inspect', spec.files), 'config', '--format', 'json', '--no-path-resolution',
      ...(materialized ? [] : ['--no-interpolate', '--no-env-resolution'])], spec.cwd, signal);
  }

  run(spec: ComposeSpec, project: string, file: string, args: string[], options: {
    signal: AbortSignal; supervisor?: RuntimeOptions['supervisor']; ownership?: NativeOwnership;
    redactions: string[]; appendLog(text: string): void; onResource(resource: Pick<Resource, 'stop'>): void;
  }): Promise<void> {
    return runNativeJob({ ...options, spec: { cwd: spec.cwd, command: ['docker', ...this.base(spec, project, [file]), ...args], env: {} }, hostEnvironment: this.environment(),
      url: '', timeoutMs: spec.timeoutMs });
  }

  capture(container: string, follow: boolean, options: {
    signal: AbortSignal; supervisor?: RuntimeOptions['supervisor']; ownership?: NativeOwnership;
    redactions: string[]; appendLog(text: string): void; onResource(resource: Pick<Resource, 'stop'>): void;
  }) {
    const input = { ...options, port: 0, url: '', hostEnvironment: this.environment(),
      spec: { cwd: this.directory, command: ['docker', ...this.dockerArgs().slice(0, -1), 'logs', ...(follow ? ['--follow'] : []), '--tail', '200', container], env: {} } };
    return follow ? startNative(input) : runNativeJob({ ...input, timeoutMs: 10000 });
  }

  close(): Promise<void> { return rm(this.directory, { recursive: true, force: true }); }
}
