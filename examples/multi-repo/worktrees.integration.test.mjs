import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createPreviewRuntime } from '../../.local/test-build/runtime.js';
import { startDaemon } from '../../.local/test-build/daemon.js';
import { testKeychain } from '../../.local/test-build/testSupport/keychain.js';

const execute = promisify(execFile);
const example = fileURLToPath(new URL('.', import.meta.url));
const project = resolve(example, '../..');
const recipe = join(example, 'worktrees.mjs');
const cli = join(project, 'dist/cli.js');
const dockerSocket = process.env.PREVIEWD_TEST_DOCKER_SOCKET;

async function request(url, pathname, body) {
  const origin = new URL(url);
  const response = await new Promise((done, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: origin.port, path: pathname,
      method: body ? 'POST' : 'GET', headers: { host: origin.host, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => done({ status: incoming.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Example request timed out.')));
    outgoing.on('error', reject);
    outgoing.end(body && JSON.stringify(body));
  });
  return { status: response.status, body: JSON.parse(response.text) };
}

test('the task recipe rejects missing paths and a different application recipe without writing a partial spec', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd-recipe-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'static.json'), JSON.stringify({ name: 'site', type: 'static', directory }));
  for (const args of [[], ['--name', 'task', '--frontend', directory, '--backend', directory, '--file', join(directory, 'static.json')]]) {
    await assert.rejects(execute(process.execPath, [recipe, ...args]), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /Supply --name|shared-notes environment/);
      return true;
    });
  }
});

test('CLI and MCP run dirty task worktrees, retain task data, and release every consumer before source removal', {
  skip: process.platform !== 'darwin' || !dockerSocket, timeout: 120_000,
}, async (t) => {
  await testKeychain(t);
  const root = await mkdtemp(join(tmpdir(), 'previewd-task-worktrees-'));
  const frontend = join(root, 'frontend task');
  const backend = join(root, 'backend task');
  const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const git = async (cwd, ...args) => (await execute('/usr/bin/git', args, { cwd, env: gitEnv, timeout: 10_000 })).stdout;
  let runtime, daemon, mcp;
  try {
    await writeFile(gitEnv.GIT_CONFIG_GLOBAL, '');
    for (const [name, directory] of [['frontend', frontend], ['backend', backend]]) {
      const repository = join(root, `${name} repository`);
      await mkdir(repository);
      if (name === 'frontend') await cp(join(example, 'frontend'), repository, { recursive: true });
      else {
        for (const service of ['api', 'reporting']) await cp(join(example, service), join(repository, service), { recursive: true });
        const { dependencies } = JSON.parse(await readFile(join(example, 'package.json'), 'utf8'));
        await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'task-backend', private: true, type: 'module', dependencies }));
      }
      await writeFile(join(repository, '.gitignore'), 'node_modules/\n.env\n');
      await git(repository, 'init', '--template=', '-b', 'main');
      await git(repository, 'config', 'user.name', 'Preview fixture');
      await git(repository, 'config', 'user.email', 'fixture@example.invalid');
      await git(repository, 'add', '.');
      await git(repository, 'commit', '-m', 'Caller source');
      await git(repository, 'worktree', 'add', '-b', `${name}-changes`, directory);
    }

    const originalPage = await readFile(join(frontend, 'index.html'), 'utf8');
    await writeFile(join(frontend, 'index.html'), originalPage.replace('Shared notes', 'Staged notes'));
    await git(frontend, 'add', 'index.html');
    await writeFile(join(frontend, 'index.html'), originalPage.replace('Shared notes', 'Current task notes'));
    for (const service of ['api', 'reporting']) {
      const file = join(backend, service, 'server.mjs');
      const source = await readFile(file, 'utf8');
      await writeFile(file, source.replace("const revision = process.env.REVISION ?? 'v1';", "import { revision } from '../task-revision.mjs';"));
    }
    await writeFile(join(backend, 'task-revision.mjs'), "export const revision = 'task-backend';\n");
    await writeFile(join(backend, '.env'), 'SYNTHETIC_PRIVATE_VALUE=never-printed-by-the-example\n');

    const sourceState = async () => Promise.all([frontend, backend].map(async (cwd) => ({
      head: await git(cwd, 'rev-parse', 'HEAD'), refs: await git(cwd, 'show-ref'),
      worktrees: await git(cwd, 'worktree', 'list', '--porcelain'),
      status: await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
      diff: await git(cwd, 'diff', '--binary'), staged: await git(cwd, 'diff', '--cached', '--binary'),
      index: await readFile(resolve(cwd, (await git(cwd, 'rev-parse', '--git-path', 'index')).trim())),
    })));
    const before = await sourceState();
    const { stdout } = await execute(process.execPath, [recipe, '--name', 'task-notes',
      '--frontend', './frontend task', '--backend', './backend task'], { cwd: root });
    const spec = JSON.parse(stdout);
    const tokenFile = join(root, 'control', 'token');
    runtime = await createPreviewRuntime({ allowedRoots: [frontend, backend],
      dataDirectory: join(root, 'control', 'data'), dockerSocket, authorize: () => true });
    daemon = await startDaemon({ runtime, tokenFile, port: 0 });
    const common = ['--endpoint', daemon.endpoint, '--token-file', tokenFile];
    const runCli = async (args, input) => {
      const pending = execute(process.execPath, [cli, ...args, ...common], { cwd: root, timeout: 40_000, maxBuffer: 1_048_576 });
      pending.child.stdin.end(input);
      return JSON.parse((await pending).stdout);
    };
    const connectMcp = async () => {
      const client = new Client({ name: 'task-worktree-test', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...common], stderr: 'pipe' });
      transport.stderr?.on('data', () => {});
      await client.connect(transport);
      return client;
    };
    const tool = async (name, args) => {
      const result = await mcp.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent.result;
    };
    const description = await runCli(['inspect', '--file', '-'], stdout);
    assert.equal(description.spec.services.frontend.cwd, await realpath(frontend));
    assert.equal(description.spec.services.api.cwd, await realpath(join(backend, 'api')));
    assert.equal(description.spec.services.reporting.cwd, await realpath(join(backend, 'reporting')));

    // A task worktree can lack packages. Starting does not install them implicitly.
    await assert.rejects(runCli(['start', '--file', '-'], stdout), (error) => {
      assert.equal(JSON.parse(error.stderr).error.code, 'START_FAILED');
      return true;
    });
    await assert.rejects(readFile(join(backend, 'node_modules/pg/package.json')), { code: 'ENOENT' });
    assert.deepEqual(await sourceState(), before);
    // The synthetic caller supplies an independent installed tree without registry traffic.
    await cp(join(project, 'node_modules'), join(backend, 'node_modules'), { recursive: true });
    const installed = await readFile(join(backend, 'node_modules/pg/package.json'));
    const first = await runCli(['start', '--file', '-'], stdout);
    assert.equal(first.state, 'ready');
    assert.match(await (await fetch(first.url)).text(), /Current task notes/);
    const getNotes = async (url) => (await request(url, '/notes')).body;
    const apiUrl = first.services.api.browserUrl;
    assert.equal((await getNotes(apiUrl)).revision, 'task-backend');
    const saved = await request(apiUrl, '/notes', { text: 'Retain this task note' });
    assert.equal(saved.status, 201);
    const summary = (await request(first.services.reporting.browserUrl, '/summary')).body;
    assert.equal(summary.totalNotes, 1);
    assert.equal(summary.cachedNote.text, 'Retain this task note');

    mcp = await connectMcp();
    assert.equal((await tool('preview_get', { name: spec.name })).active.id, first.id);
    const neighborSpec = { ...spec, name: 'other-task' };
    const neighborStart = await tool('preview_start', { spec: neighborSpec });
    const neighbor = await tool('preview_wait', { name: neighborSpec.name, attemptId: neighborStart.candidate.id });
    assert.equal(neighbor.state, 'ready');
    assert.deepEqual((await getNotes(neighbor.services.api.browserUrl)).notes, []);
    await mcp.close();
    assert.equal((await getNotes(apiUrl)).notes.length, 1);
    mcp = await connectMcp();
    assert.equal((await tool('preview_get', { name: spec.name })).active.id, first.id);

    const changedPage = (await readFile(join(frontend, 'index.html'), 'utf8')).replace('Current task notes', 'Live task edit');
    await writeFile(join(frontend, 'index.html'), changedPage);
    const afterEdit = await sourceState();
    assert.match(await (await fetch(first.url)).text(), /Live task edit/);
    const failedSpec = structuredClone(spec);
    failedSpec.services.api.command = [process.execPath, '-e', 'process.exit(1)'];
    const failedStart = await tool('preview_replace', { name: spec.name, spec: failedSpec });
    const failed = await tool('preview_wait', { name: spec.name, attemptId: failedStart.candidate.id });
    assert.equal(failed.state, 'failed');
    assert.equal((await tool('preview_get', { name: spec.name })).active.id, first.id);
    assert.match(await (await fetch(first.url)).text(), /Live task edit/);
    const pending = await tool('preview_replace', { name: spec.name, spec });
    await tool('preview_cancel', { name: spec.name, attemptId: pending.candidate.id });
    assert.equal((await tool('preview_get', { name: spec.name })).active.id, first.id);

    await runCli(['stop', spec.name]);
    await assert.rejects(fetch(first.url));
    assert.equal((await getNotes(neighbor.services.api.browserUrl)).notes.length, 0);
    assert.deepEqual(await sourceState(), afterEdit);
    const resumed = await runCli(['start', '--file', '-'], stdout);
    assert.equal((await getNotes(resumed.services.api.browserUrl)).notes[0].text, 'Retain this task note');
    assert.deepEqual(await sourceState(), afterEdit);
    assert.deepEqual(await readFile(join(backend, 'node_modules/pg/package.json')), installed);
    assert.equal(await readFile(join(backend, '.env'), 'utf8'), 'SYNTHETIC_PRIVATE_VALUE=never-printed-by-the-example\n');

    // Both submitted specs consume these paths, even though their preview names differ.
    for (const submitted of [spec, neighborSpec]) await tool('preview_stop', { name: submitted.name });
    for (const [name, directory] of [['frontend', frontend], ['backend', backend]]) {
      await git(join(root, `${name} repository`), 'worktree', 'remove', '--force', directory);
    }
    for (const name of [spec.name, neighborSpec.name]) {
      assert.ok((await tool('preview_get', { name })).data);
      await tool('preview_delete_data', { name });
      assert.equal((await tool('preview_get', { name })).data, undefined);
    }
  } finally {
    await mcp?.close();
    if (runtime) {
      for (const { name } of await runtime.list()) {
        await runtime.stop(name);
        if ((await runtime.get(name)).data) await runtime.deleteData(name);
      }
    }
    if (daemon) await daemon.close();
    else await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
