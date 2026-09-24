import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { z } from 'zod';
import { requestSchemas, limits, type ConfigurationBindingChange, type ConfigurationBindingRow, type PreviewDescription, type PreviewStatus, type EffectiveSpec, type StopOptions } from './contracts.js';
import { configurationBindings, changeConfigurationBindings, loadPreviewSpec, readPreviewSpec, resolvePreviewFile, readConfigurationDocument, updateConfigurationDocument, type ConfigurationDocument } from './config.js';
import { connectProject, discoverProjectOwners, projectOwnerDirectory, type ProjectOwnerInfo } from './project.js';
import { connectPreviewDaemon } from './client.js';
import { canonicalDirectory, describeSpec, normalizeSources, parseSpec, sourceDirectories } from './spec.js';
import { failure, PreviewError, throwIfAborted } from './errors.js';
import { secretRequirements } from './secrets.js';

export interface ConfigurationView {
  id: string; project: string; file?: string; description: PreviewDescription;
  bindings: ConfigurationBindingRow[]; existing?: PreviewStatus;
}
export interface PreviewReview extends ConfigurationView {
  inspection: PreviewDescription; inspectionError?: string; executionBlocked?: string;
  sources: string[]; commands: string[]; managedData: string[]; secretIds: string[];
}
const path = z.string().min(1).max(4096);
const changes = requestSchemas.configureBindings.shape.changes;
const workflowSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('previewProjects') }),
  z.strictObject({ action: z.literal('configurationOpen'), owner: z.string(), name: z.string().optional(), attemptId: z.string().optional(), file: path.optional() }),
  z.strictObject({ action: z.enum(['configurationSave', 'configurationReview']), id: z.uuid(), changes }),
  z.strictObject({ action: z.literal('previewPrepare'), project: path, file: path.optional(), text: z.string().max(limits.controlBytes).optional(), format: z.enum(['yaml', 'json']).optional() }),
  z.strictObject({ action: z.literal('previewLaunch'), id: z.uuid(), approved: z.literal(true) }),
  z.strictObject({ action: z.literal('previewSecrets'), id: z.uuid(), approved: z.literal(true), reopen: z.boolean().optional() }),
  z.strictObject({ action: z.literal('previewSetupStatus'), id: z.uuid(), requestId: z.uuid() }),
]);
type Owner = Awaited<ReturnType<typeof discoverProjectOwners>>[number];
type Client = ReturnType<typeof connectPreviewDaemon>;
type WithOwner = <T>(owner: Owner, operation: (client: Client, info: ProjectOwnerInfo) => Promise<T>, readBudget?: number) => Promise<T>;
type Draft = ConfigurationView & {
  touched: number; busy?: boolean; reviewed?: boolean; spec?: EffectiveSpec; document?: ConfigurationDocument;
  changes: ConfigurationBindingChange[]; roots: string[]; attemptId?: string;
  expected: NonNullable<StopOptions['expected']>; setupId?: string; inspectionError?: string;
};
const expected = (status?: PreviewStatus): NonNullable<StopOptions['expected']> => ({ active: status?.active?.id ?? null, candidate: status?.candidate?.id ?? null, latest: status?.latest?.id ?? null });

/** Short-lived form drafts keep undisclosed literals on the server. Files and attempts remain authoritative. */
export class DashboardWorkflows {
  private readonly drafts = new Map<string, Draft>();
  private readonly savingFiles = new Set<string>();
  constructor(private readonly discover: typeof discoverProjectOwners, private readonly withOwner: WithOwner) {}
  close() { this.drafts.clear(); }

  private async project<T>(directory: string, start: false | { allowExec: boolean }, roots: string[], operation: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = (await this.discover()).find(item => (item.connection ?? item.retained)?.projectDirectory === directory);
    if (owner?.connection) return this.withOwner(owner, async (client, info) => {
      if (start) {
        if (start.allowExec && !info.allowExec) throw new PreviewError('EXECUTION_DENIED', 'This owner does not allow execution. Shut down this project’s owner and relaunch it with --allow-exec; its running previews will stop.');
        if (signal) throwIfAborted(signal);
        await client.allowSources(roots, signal);
      }
      return operation(client);
    });
    if (owner?.error) throw new PreviewError(owner.error.code, owner.error.message);
    if (signal) throwIfAborted(signal);
    const client = connectProject({ projectDirectory: directory, allowedRoots: roots, ...(start ? { allowExec: start.allowExec } : {}) });
    const abort = () => { void client.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try { return await operation(client); }
    finally { signal?.removeEventListener('abort', abort); await client.close(); }
  }
  private put(draft: Omit<Draft, 'id' | 'touched'>): Draft {
    for (const [id, item] of this.drafts) if (Date.now() - item.touched > 30 * 60_000 && !item.busy) this.drafts.delete(id);
    if (this.drafts.size >= 16) {
      const oldest = [...this.drafts.values()].filter(item => !item.busy).sort((a, b) => a.touched - b.touched)[0];
      if (!oldest) throw new PreviewError('BUSY', 'Configuration requests are busy. Try again shortly.');
      this.drafts.delete(oldest.id);
    }
    const result = { ...draft, id: randomUUID(), touched: Date.now() };
    this.drafts.set(result.id, result);
    return result;
  }
  private view(draft: Draft): ConfigurationView {
    return { id: draft.id, project: draft.project, file: draft.file, description: draft.description, bindings: draft.bindings, existing: draft.existing };
  }
  private async status(project: string, roots: string[], name: string) {
    try { return await this.project(project, false, roots, client => client.get(name)); }
    catch (error) { if (error instanceof PreviewError && ['NOT_FOUND', 'DAEMON_UNAVAILABLE'].includes(error.code)) return undefined; throw error; }
  }
  private async file(project: string, filename?: string, allowedRoots = [project]) {
    const file = filename ? resolve(project, filename) : await resolvePreviewFile(project);
    const spec = parseSpec(await loadPreviewSpec(file, { allowedRoots }));
    const roots = [...new Set([project, ...await Promise.all(sourceDirectories(spec).map(canonicalDirectory))])];
    const document = await readConfigurationDocument(file, { allowedRoots: [...new Set([...roots, ...allowedRoots])] });
    return { file: document.file, roots, document, spec: document.spec };
  }
  private async fresh(draft: Draft) {
    if (draft.document) {
      const current = await readConfigurationDocument(draft.document.file, { allowedRoots: [...draft.roots, dirname(draft.document.file)] });
      if (current.text !== draft.document.text || !isDeepStrictEqual(current.identity, draft.document.identity)) throw new PreviewError('STALE_ATTEMPT', 'The recipe changed outside this view. Reload it before continuing.');
    }
    // Resolve the exact source roots again; replacing a directory symlink is not additional approval.
    if ((await Promise.all(draft.roots.map(canonicalDirectory))).some((root, index) => root !== draft.roots[index])) {
      throw new PreviewError('SOURCE_DENIED', 'A source folder changed. Review the configuration again.');
    }
  }
  private async review(draft: Draft): Promise<PreviewReview> {
    let inspection = draft.description;
    let inspectionError = draft.inspectionError;
    if (draft.spec) {
      try { inspection = await this.project(draft.project, false, draft.roots, client => client.inspect(draft.spec!)); }
      catch (error) { inspectionError = failure(error).message; }
    }
    const nodes = draft.description.spec.type === 'environment' ? Object.entries(draft.description.spec.services) : [['app', draft.description.spec] as const];
    const owner = (await this.discover()).find(item => item.connection?.projectDirectory === draft.project);
    const executes = nodes.some(([, node]) => ['command', 'job', 'postgres', 'redis', 'external-postgres', 'external-redis'].includes(node.type));
    const executionBlocked = owner && executes && !await this.withOwner(owner, async (_client, info) => info.allowExec)
      ? 'This owner does not allow execution. Explicitly shut down this project’s owner, then start it with --allow-exec. Shutdown stops its previews and ends secret approvals; data is retained.' : undefined;
    draft.reviewed = true;
    return { ...this.view(draft), inspection, inspectionError, executionBlocked, sources: draft.roots,
      commands: nodes.flatMap(([id, node]) => 'command' in node && node.command ? [`${id}: ${node.command.join(' ')} · ${node.cwd}`] : []),
      managedData: nodes.filter(([, node]) => node.type === 'postgres' || node.type === 'redis').map(([id]) => id),
      secretIds: draft.spec ? secretRequirements(draft.spec, new Set()).map(item => item.id) : draft.description.secrets?.map(item => item.id) ?? [],
    };
  }
  async dispatch(input: unknown, signal: AbortSignal): Promise<{ result: unknown } | undefined> {
    if (!input || typeof input !== 'object' || !('action' in input) || typeof input.action !== 'string' || !workflowSchema.options.some(schema => schema.shape.action.safeParse(input.action).success)) return;
    const parsed = workflowSchema.safeParse(input);
    if (!parsed.success) throw new PreviewError('INVALID_INPUT', 'Invalid configuration action. Review the fields and try again.');
    const p = parsed.data;
    throwIfAborted(signal);
    if (p.action === 'previewProjects') {
      const projects = new Map<string, { directory: string; branch?: string }>();
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
      for (const owner of await this.discover()) {
        const directory = (owner.connection ?? owner.retained)?.projectDirectory;
        if (!directory || projects.has(directory)) continue;
        projects.set(directory, { directory });
        try {
          const { stdout } = await promisify(execFile)('git', ['-C', directory, 'worktree', 'list', '--porcelain', '-z'], { env, signal, timeout: 2000, maxBuffer: 262144 });
          let item: { directory: string; branch?: string } | undefined;
          for (const field of stdout.split('\0')) {
            if (field.startsWith('worktree ')) { item = { directory: field.slice(9) }; projects.set(item.directory, item); }
            else if (item && field.startsWith('branch refs/heads/')) item.branch = field.slice(18);
          }
        } catch { /* Non-Git and missing folders remain selectable by their recorded identity. */ }
      }
      return { result: { projects: [...projects.values()].sort((a, b) => a.directory.localeCompare(b.directory)) } };
    }
    if (p.action === 'previewPrepare') {
      const project = await canonicalDirectory(p.project);
      if (p.text !== undefined && p.file !== undefined) throw new PreviewError('INVALID_INPUT', 'Choose a recipe file or enter configuration, not both.');
      let data: Awaited<ReturnType<DashboardWorkflows['file']>> | { spec: EffectiveSpec; roots: string[] };
      if (p.text !== undefined) {
        const spec = parseSpec(await readPreviewSpec(Readable.from([p.text]), { baseDirectory: project, format: p.format ?? 'yaml' }));
        const roots = [...new Set([project, ...await Promise.all(sourceDirectories(spec).map(canonicalDirectory))])];
        data = { spec: await normalizeSources(spec, roots), roots };
      } else data = await this.file(project, p.file);
      const existing = await this.status(project, data.roots, data.spec.name);
      const draft = this.put({ ...data, project, description: describeSpec(data.spec), bindings: configurationBindings(data.spec), existing, expected: expected(existing), changes: [] });
      return { result: await this.review(draft) };
    }
    if (p.action === 'configurationOpen') {
      if (p.attemptId && !p.name) throw new PreviewError('INVALID_INPUT', 'Select a preview name and attempt.');
      const owner = (await this.discover()).find(owner => owner.id === p.owner);
      const project = (owner?.connection ?? owner?.retained)?.projectDirectory;
      if (!owner || !project) throw new PreviewError('NOT_FOUND', 'This project is unavailable.');
      const description = p.attemptId ? await this.withOwner(owner, client => client.describe(p.name!, p.attemptId!)) : undefined;
      const filename = p.file ?? description?.sourceFile;
      // An unrelated root recipe is not the source of a retained direct configuration.
      if (filename || !p.attemptId) {
        const fileRoots = owner.connection ? await this.withOwner(owner, async (_client, info) => info.allowedRoots) : [project];
        const data = await this.file(project, filename, fileRoots);
        const existing = await this.status(project, data.roots, data.spec.name);
        return { result: this.view(this.put({ ...data, project, description: describeSpec(data.spec), bindings: configurationBindings(data.spec), existing, expected: expected(existing), changes: [] })) };
      }
      const direct = await this.withOwner(owner, client => client.configureBindings(p.name!, p.attemptId!, [], { operation: 'inspect' }, { signal }));
      if (!('description' in direct)) throw new PreviewError('INVALID_INPUT', 'The owner returned an invalid configuration.');
      const existing = await this.status(project, [project], p.name!);
      const roots = [project, ...Object.values(description!.spec.type === 'environment' ? description!.spec.services : { app: description!.spec }).flatMap(node => 'cwd' in node && node.cwd ? [node.cwd] : 'directory' in node && node.directory ? [node.directory] : [])];
      return { result: this.view(this.put({ project, description: { ...direct.description, prerequisites: direct.inspection?.prerequisites }, inspectionError: direct.inspection?.error?.message, bindings: direct.bindings, existing, roots: [...new Set(roots)], expected: expected(existing), changes: [], attemptId: p.attemptId })) };
    }
    const draft = this.drafts.get(p.id);
    if (!draft || Date.now() - draft.touched > 30 * 60_000) throw new PreviewError('NOT_FOUND', 'This configuration view expired. Open it again.');
    if (draft.busy) throw new PreviewError('BUSY', 'This configuration is being updated. Wait for it to finish.');
    const savingFile = p.action === 'configurationSave' ? draft.document?.file : undefined;
    if (savingFile && this.savingFiles.has(savingFile)) throw new PreviewError('BUSY', 'This file is being saved. Reload after the save finishes.');
    if (savingFile) this.savingFiles.add(savingFile);
    draft.busy = true; draft.touched = Date.now();
    try {
      await this.fresh(draft);
      if (p.action === 'configurationSave') {
        if (draft.document) {
          draft.document = await updateConfigurationDocument(draft.document, p.changes, { allowedRoots: [...draft.roots, dirname(draft.document.file)], signal });
          draft.spec = draft.document.spec;
        } else if (draft.attemptId) {
          const saved = await this.project(draft.project, false, draft.roots, client => client.configureBindings(draft.description.spec.name, draft.attemptId!, p.changes, { operation: 'save' }, { signal }));
          if (!('file' in saved)) throw new PreviewError('INVALID_INPUT', 'The owner did not save the configuration.');
          Object.assign(draft, await this.file(draft.project, saved.file));
        } else throw new PreviewError('INVALID_INPUT', 'Apply this unsaved configuration first, then save it from Configuration.');
        draft.file = draft.document!.file; draft.description = describeSpec(draft.spec!); draft.bindings = configurationBindings(draft.spec!); draft.changes = []; draft.setupId = undefined; draft.reviewed = false;
        return { result: this.view(draft) };
      }
      if (p.action === 'configurationReview') {
        if (draft.document && p.changes.length) throw new PreviewError('INVALID_INPUT', 'Save your file changes before applying them.');
        if (!isDeepStrictEqual(draft.changes, p.changes)) draft.setupId = undefined;
        draft.changes = p.changes;
        if (draft.attemptId && !draft.document) {
          const inspected = await this.project(draft.project, false, draft.roots, client => client.configureBindings(draft.description.spec.name, draft.attemptId!, p.changes, { operation: 'inspect' }, { signal }));
          if (!('description' in inspected)) throw new PreviewError('INVALID_INPUT', 'The owner returned an invalid configuration.');
          draft.description = { ...inspected.description, prerequisites: inspected.inspection?.prerequisites }; draft.inspectionError = inspected.inspection?.error?.message; draft.bindings = inspected.bindings;
        } else if (draft.spec) {
          draft.spec = changeConfigurationBindings(draft.spec, p.changes);
          draft.description = describeSpec(draft.spec); draft.bindings = configurationBindings(draft.spec);
        }
        return { result: await this.review(draft) };
      }
      if (p.action === 'previewSetupStatus') return { result: await this.project(draft.project, false, draft.roots, client => client.secretsStatus(p.requestId)) };
      if (!draft.reviewed) throw new PreviewError('INVALID_INPUT', 'Review the configuration before starting it.');
      throwIfAborted(signal);
      if (p.action === 'previewLaunch' && !draft.setupId) {
        const nodes = draft.description.spec.type === 'environment' ? Object.values(draft.description.spec.services) : [draft.description.spec];
        const privateSetup = nodes.some(node => node.type === 'postgres' || node.type === 'redis') || (draft.spec ? secretRequirements(draft.spec, new Set()).length > 0 : draft.description.secrets?.length);
        if (privateSetup) throw new PreviewError('SECRET_REQUIRED', 'Complete private setup before starting this configuration.');
      }
      const nodes = draft.description.spec.type === 'environment' ? Object.values(draft.description.spec.services) : [draft.description.spec];
      const allowExec = nodes.some(node => ['command', 'job', 'postgres', 'redis', 'external-postgres', 'external-redis'].includes(node.type));
      const result = await this.project(draft.project, { allowExec }, draft.roots, async client => {
        throwIfAborted(signal);
        if (p.action === 'previewSecrets') {
          const setup = draft.spec ? await client.secretsSetup(draft.spec, { reopen: p.reopen, signal }) : await client.configureBindings(draft.description.spec.name, draft.attemptId!, draft.changes, { operation: 'secrets', reopen: p.reopen }, { signal });
          draft.setupId = setup.id;
          return setup;
        }
        if (draft.setupId) {
          const setup = await client.secretsStatus(draft.setupId);
          if (setup.state !== 'complete') throw new PreviewError('SECRET_REQUIRED', setup.state === 'canceled'
            ? 'Private setup was canceled. Reopen it only when you want to continue.' : 'Complete private setup before starting.');
        }
        throwIfAborted(signal);
        const options = { expected: draft.expected, ...(draft.file ? { sourceFile: draft.file } : {}) };
        const status = draft.spec ? draft.expected.active ? await client.replace(draft.spec.name, draft.spec, options) : await client.start(draft.spec, options)
          : await client.configureBindings(draft.description.spec.name, draft.attemptId!, draft.changes, { operation: 'apply', expected: draft.expected }, { signal });
        draft.reviewed = false;
        return { owner: basename(projectOwnerDirectory(draft.project)), name: draft.description.spec.name, status };
      }, signal);
      return { result };
    } finally { draft.busy = false; if (savingFile) this.savingFiles.delete(savingFile); }
  }
}
