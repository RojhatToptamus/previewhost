import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { connectPreviewDaemon, type ClientOptions } from './client.js';
import { limits, requestSchemas, type PreviewApi } from './contracts.js';
import { failure, PreviewError } from './errors.js';

/** All tools call the same public API; the MCP host owns tool approval UI. */
export function createMcpServer(client: PreviewApi): McpServer {
  const server = new McpServer({ name: 'previewd', version: '0.1.0' }, {
    instructions: 'Manage local HTTP previews through an explicitly started previewd daemon. Start or replace returns an attempt: wait for its id before using the URL. A wait timeout does not stop startup. Cancel requires the exact attempt id; stop affects the named preview. Disconnecting leaves previews running. Commands require the daemon owner to enable execution. Never retry a mutation automatically after a connection error; inspect get/list first.',
  });
  let active = 0;
  let waits = 0;
  async function run(kind: 'request' | 'wait' | 'cleanup', fn: () => Promise<unknown>): Promise<CallToolResult> {
    let counted = false;
    try {
      if (active >= limits.controlRequests - (kind === 'cleanup' ? 0 : 2) || (kind === 'wait' && waits >= limits.controlWaits)) {
        throw new PreviewError('BUSY', 'MCP request capacity is full; stop and cancel retain reserved capacity.');
      }
      active++; counted = true;
      if (kind === 'wait') waits++;
      const value = { result: await fn() };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const value = { error: failure(error) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } finally {
      if (counted) { active--; if (kind === 'wait') waits--; }
    }
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const cleanup = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  server.registerTool('preview_inspect', {
    description: 'Validate a preview spec and describe its source, command, and cleanup without starting or approving it.',
    inputSchema: requestSchemas.inspect, annotations: read,
  }, ({ spec }) => run('request', () => client.inspect(spec)));
  server.registerTool('preview_start', {
    description: 'Start a named preview. Returns a starting attempt; use preview_wait with its id. Execution must already be permitted by the daemon owner.',
    inputSchema: requestSchemas.start, annotations: write,
  }, ({ spec }) => run('request', () => client.start(spec)));
  server.registerTool('preview_replace', {
    description: 'Prepare a replacement while keeping the active route. Wait for the returned candidate id. Failure before cutover keeps the old preview.',
    inputSchema: requestSchemas.replace, annotations: { ...write, destructiveHint: true },
  }, ({ name, spec }) => run('request', () => client.replace(name, spec)));
  server.registerTool('preview_list', {
    description: 'List bounded current preview observations. Use after a lost start or replace response before retrying.',
    inputSchema: requestSchemas.list, annotations: read,
  }, () => run('request', () => client.list()));
  server.registerTool('preview_get', {
    description: 'Read the active attempt, candidate, latest outcome, and any incomplete cleanup for a name.',
    inputSchema: requestSchemas.get, annotations: read,
  }, ({ name }) => run('request', () => client.get(name)));
  server.registerTool('preview_wait', {
    description: 'Wait up to 30 seconds for one exact attempt. Timeout or canceling this wait leaves the preview running.',
    inputSchema: requestSchemas.wait, annotations: read,
  }, ({ name, attemptId, timeoutMs }, context) => run('wait', () => client.wait(name, attemptId, { timeoutMs, signal: context.mcpReq.signal })));
  server.registerTool('preview_logs', {
    description: 'Read a bounded log tail for an attempt. Known supplied environment values are redacted; other application output can contain secrets.',
    inputSchema: requestSchemas.logs, annotations: read,
  }, ({ name, attemptId, maxBytes }) => run('request', () => client.logs(name, attemptId, maxBytes)));
  server.registerTool('preview_cancel', {
    description: 'Cancel only the specified pending candidate and join its cleanup. A stale id never cancels a later attempt.',
    inputSchema: requestSchemas.cancel, annotations: cleanup,
  }, ({ name, attemptId }) => run('cleanup', () => client.cancel(name, attemptId)));
  server.registerTool('preview_stop', {
    description: 'Stop the named preview and join all owned cleanup. Attached external servers and caller source files remain owned by their original owner.',
    inputSchema: requestSchemas.stop, annotations: cleanup,
  }, ({ name }) => run('cleanup', () => client.stop(name)));
  return server;
}

/** Stdio is an adapter lifetime; EOF closes requests, never daemon previews. */
export function runMcp(options: ClientOptions = {}): { close(): Promise<void> } {
  const client = connectPreviewDaemon(options);
  let closing: Promise<void> | undefined;
  const handle = serveStdio(() => createMcpServer(client), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: limits.controlBytes }),
    onerror: () => { process.stderr.write('previewd MCP transport error.\n'); void close(); },
  });
  function close(): Promise<void> {
    if (!closing) {
      process.stdin.off('end', onEnd);
      process.off('SIGINT', onEnd); process.off('SIGTERM', onEnd);
      closing = (async () => { await client.close(); await handle.close(); })();
    }
    return closing;
  }
  const onEnd = () => { void close(); };
  process.stdin.once('end', onEnd);
  process.once('SIGINT', onEnd); process.once('SIGTERM', onEnd);
  return { close };
}
