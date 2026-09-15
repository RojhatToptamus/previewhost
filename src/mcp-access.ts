import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { inputRequired, type CallToolResult, type InputRequiredResult, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { connectProject, type ProjectOptions } from './project.js';
import { canonicalDirectory, isWithin } from './spec.js';
import { failure, PreviewError, throwIfAborted } from './errors.js';

export const accessSchema = z.strictObject({
  project: z.string().min(1).max(4096).describe('Absolute root of this chat’s actual checkout or worktree.'),
  sources: z.array(z.string().min(1).max(4096)).max(31).default([])
    .describe('Additional source directories required by this environment, such as its separate backend repository. Never supply secret files or a parent directory merely to bypass access approval.'),
});

/** Connection permission is separate from the owner's continuing runtime authority. */
export class McpAccess {
  private readonly controller = new AbortController();
  private readonly grants = new Map<string, string[]>();
  private readonly pending = new Map<string, { project: string; sources: string[]; expires: number }>();
  constructor(private readonly options: ProjectOptions) {}

  async roots(project: string | undefined): Promise<string[]> {
    if (!project) throw new PreviewError('INVALID_INPUT', 'Supply this chat’s actual project on every call.');
    const canonical = await canonicalDirectory(project);
    const roots = this.grants.get(canonical);
    if (!roots) throw new PreviewError('SOURCE_DENIED', 'Request preview_access for this chat’s actual project and required backend sources. The user approves access in this client; no registration changes are needed.');
    return [...roots];
  }

  async request(input: z.output<typeof accessSchema>, context: ServerContext): Promise<CallToolResult | InputRequiredResult> {
    const signal = AbortSignal.any([context.mcpReq.signal, this.controller.signal]);
    try {
      throwIfAborted(signal);
      const project = await canonicalDirectory(input.project);
      const sources = [...new Set([project, ...await Promise.all(input.sources.map(canonicalDirectory))])].sort();
      const home = await canonicalDirectory(homedir());
      if (sources.some(path => isWithin(path, home))) throw new PreviewError('SOURCE_DENIED', 'Choose the actual project and dependency directories, not your home directory or its parents.');
      const existing = this.grants.get(project) ?? [];
      if (sources.every(path => existing.some(root => isWithin(root, path)))) {
        // An owner may have restarted while this approved MCP connection stayed open.
        await this.allowSources(project, existing, signal);
        return this.result(project, existing);
      }
      for (const [id, request] of this.pending) if (request.expires < Date.now()) this.pending.delete(id);
      const state = context.mcpReq.requestState();
      if (state !== undefined) {
        const request = typeof state === 'string' ? this.pending.get(state) : undefined;
        if (!request || request.project !== project || JSON.stringify(request.sources) !== JSON.stringify(sources)) {
          throw new PreviewError('SOURCE_DENIED', 'The access request expired or changed. Request fresh approval for the intended directories.');
        }
        this.pending.delete(state as string);
        const response = z.strictObject({ action: z.enum(['accept', 'decline', 'cancel']), content: z.object({ allow: z.boolean() }).optional() })
          .safeParse(context.mcpReq.inputResponses?.access);
        if (!response.success || response.data.action !== 'accept' || response.data.content?.allow !== true) {
          throw new PreviewError('SOURCE_DENIED', 'Project access was declined or canceled. Stop this workflow. Do not request access again until the user explicitly asks to continue.');
        }
        // A client response only approves the exact server-held directories above.
        throwIfAborted(signal);
        await this.allowSources(project, sources, signal);
        throwIfAborted(signal);
        const roots = [...new Set([...(this.grants.get(project) ?? []), ...sources])];
        this.grants.set(project, roots);
        return this.result(project, roots);
      }
      if (this.pending.size >= 8) throw new PreviewError('BUSY', 'Finish an earlier project access request before opening another.');
      const id = randomUUID();
      this.pending.set(id, { project, sources, expires: Date.now() + 5 * 60_000 });
      return inputRequired({ requestState: id, inputRequests: {
        access: inputRequired.elicit({
          message: `Allow Previewhost to use this project?\n\nProject: ${project}\nSource directories:\n${sources.map(path => `• ${path}`).join('\n')}\n\nCommands run as your local user when execution is enabled. This connection can manage previews for this project. Other worktrees require separate approval. Secret access still requires the private form. Reconnection requires project approval again; existing previews keep running.`,
          requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: 'Allow access to these directories', default: false } }, required: ['allow'] },
        }),
      } });
    } catch (error) {
      const value = { error: failure(error) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
  }

  private async allowSources(project: string, sources: string[], signal: AbortSignal) {
    const client = connectProject({ ...this.options, projectDirectory: project });
    try { await client.allowSources(sources, signal); }
    finally { await client.close(); }
  }

  private result(project: string, sources: string[]): CallToolResult {
    const value = { result: { project, sources, message: 'Access approved. Continue with this project on every call. Inspect dependencies and use preview.yml if present, otherwise submit a direct spec.' } };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  }
  close() { this.controller.abort(); this.grants.clear(); this.pending.clear(); }
}
