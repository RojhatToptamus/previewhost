import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createPreviewRuntime } from './runtime.js';
import { startDaemon } from './daemon.js';
import type { LogResult, PreviewSpec, PreviewStatus } from './contracts.js';

const execute = promisify(execFile);
test('CLI and MCP share real job results, rerun guards, authorization and cancellation', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-job-transports-'));
  let approved = true;
  let rerunAuthorized = false;
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: request => {
    if (request.operation === 'start' && request.rerunJob) rerunAuthorized = true;
    return approved;
  } });
  const tokenFile = join(directory, 'control', 'token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const cli = resolve('dist/cli.js');
  const common = ['--endpoint', daemon.endpoint, '--token-file', tokenFile];
  const mcp = new Client({ name: 'job-test', version: '1' });
  try {
    await writeFile(join(directory, 'index.html'), 'job application');
    const spec: PreviewSpec = { name: 'wire-jobs', type: 'environment', primary: 'web', services: {
      prepare: { type: 'job', cwd: directory, command: [process.execPath, '-e', "require('fs').appendFileSync('runs','x');console.log('finished');"] },
      web: { type: 'static', directory, dependsOn: ['prepare'] },
    } };
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...common], stderr: 'pipe' }));
    const call = async (name: string, args: object) => {
      const response = await mcp.callTool({ name, arguments: { ...args } });
      assert.ok(!response.isError, JSON.stringify(response));
      return (response.structuredContent as { result: PreviewStatus }).result;
    };
    const started = await call('preview_start', { spec });
    const ready = await runtime.wait(spec.name, started.candidate!.id);
    assert.equal(ready.services?.prepare.state, 'succeeded');
    assert.equal(await (await fetch(ready.url!)).text(), 'job application');
    const logArgs = { name: spec.name, attemptId: ready.id, source: 'prepare' };
    const output = await mcp.callTool({ name: 'preview_logs', arguments: logArgs });
    assert.ok(!output.isError);
    const log = (output.structuredContent as { result: LogResult }).result;
    assert.match(log.text, /finished\n/);
    const cliLog = JSON.parse((await execute(process.execPath, [cli, 'logs', spec.name, ready.id, '--source', 'prepare', '--after', '0', '--max-bytes', '4', ...common])).stdout) as LogResult;
    assert.equal(cliLog.text, log.text.slice(0, 4)); assert.equal(cliLog.truncated, false);
    const rest = await mcp.callTool({ name: 'preview_logs', arguments: { ...logArgs, after: cliLog.cursor } });
    assert.equal((rest.structuredContent as { result: LogResult }).result.text, log.text.slice(4));
    const empty = await mcp.callTool({ name: 'preview_logs', arguments: { ...logArgs, after: log.cursor } });
    assert.equal((empty.structuredContent as { result: LogResult }).result.text, '');
    const deniedLive = await mcp.callTool({ name: 'preview_rerun_job', arguments: { name: spec.name, attemptId: ready.id, job: 'prepare' } });
    assert.equal(deniedLive.isError, true);
    await call('preview_stop', { name: spec.name });
    const rerun = JSON.parse((await execute(process.execPath, [cli, 'rerun-job', spec.name, ready.id, 'prepare', ...common])).stdout) as PreviewStatus;
    assert.equal((await runtime.wait(spec.name, rerun.candidate!.id)).state, 'ready');
    assert.equal(await readFile(join(directory, 'runs'), 'utf8'), 'xx');
    assert.equal(rerunAuthorized, true);
    await runtime.stop(spec.name);
    approved = false;
    const blocked = await call('preview_rerun_job', { name: spec.name, attemptId: rerun.candidate!.id, job: 'prepare' });
    assert.equal((await runtime.wait(spec.name, blocked.candidate!.id)).error?.code, 'EXECUTION_DENIED');
    assert.equal(await readFile(join(directory, 'runs'), 'utf8'), 'xx');
    approved = true;
    if (spec.services.prepare.type === 'job') spec.services.prepare.command = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
    const pending = await call('preview_start', { spec });
    const canceled = await call('preview_cancel', { name: spec.name, attemptId: pending.candidate!.id });
    assert.equal(canceled.latest?.state, 'canceled');
  } finally { await mcp.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }); }
});
