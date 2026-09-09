import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewRuntime, connectPreviewDaemon } from 'previewhost';

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, 'node_modules/previewhost');
const binary = join(directory, 'node_modules/.bin/previewhost');
const site = join(directory, 'site');
const previousHome = process.env.HOME;
process.env.HOME = join(directory, 'home');
const children = new Set();
let runtime, client, daemon, rpcChild;
let daemonInfo;
function record(name, details = {}) { console.log(JSON.stringify({ name, result: 'pass', ...details })); }
function child(args, absoluteNode = false) {
  const proc = spawn(absoluteNode ? process.execPath : binary, absoluteNode ? [join(root, 'dist/cli.js'), ...args] : args, {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: absoluteNode ? { ...process.env, PATH: '/usr/bin:/bin' } : process.env,
  });
  children.add(proc);
  proc.closed = new Promise((resolve) => proc.once('close', (code, signal) => { children.delete(proc); resolve({ code, signal }); }));
  proc.output = ''; proc.errors = '';
  proc.stdout.on('data', (bytes) => { proc.output = (proc.output + bytes).slice(-1_048_576); });
  proc.stderr.on('data', (bytes) => { proc.errors = (proc.errors + bytes).slice(-65_536); });
  proc.stdin.on('error', () => {});
  proc.once('error', (error) => { proc.errors += error.message; });
  return proc;
}
async function bounded(work, timeout = 10_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline exceeded')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function cli(args) {
  const proc = child(args); proc.stdin.end();
  const result = await bounded(proc.closed);
  assert.equal(result.code, 0, proc.errors); assert.equal(proc.errors, '');
  return JSON.parse(proc.output);
}
async function fetchText(url) { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); return response.text(); }
async function gone(url) { await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) })); }

try {
  assert.equal(import.meta.resolve('previewhost'), new URL('./node_modules/previewhost/dist/index.js', import.meta.url).href);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'previewhost');
  const inventory = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
  const allowed = /^(?:package\.json|README\.md|LICENSE|NOTICE|dist\/[^/]+\.(?:js|d\.ts)|dist\/native\/keychain|examples\/(?:static\.json|command\.json|server\.mjs|site\/index\.html))$/;
  for (const file of inventory) {
    assert(allowed.test(file) && !file.includes('.test.'), `Unexpected packaged file: ${file}`);
  }
  const keychain = join(root, 'dist/native/keychain');
  assert((await stat(keychain)).mode & 0o111, 'The packaged Keychain helper must be executable.');
  assert.deepEqual(execFileSync('/usr/bin/lipo', ['-archs', keychain], { encoding: 'utf8' }).trim().split(/\s+/).sort(), ['arm64', 'x86_64']);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', keychain]);
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/supervisor.js', 'examples/static.json', 'examples/command.json', 'examples/server.mjs', 'examples/site/index.html', 'LICENSE', 'NOTICE']) assert(inventory.includes(file), `Missing packaged file: ${file}`);
  assert.deepEqual(manifest.bin, { previewhost: './dist/cli.js' });
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[hook], undefined);
  for (const extra of ['typescript', '@types/node', '@modelcontextprotocol/client']) await assert.rejects(stat(join(directory, 'node_modules', extra)));
  assert((await stat(binary)).mode & 0o111);
  await mkdir(site, { recursive: true });
  await writeFile(join(site, 'index.html'), 'packaged-static');
  await writeFile(join(site, 'server.mjs'), 'import http from "node:http"; http.createServer((_q,r)=>r.end(JSON.stringify({message:"packaged-native",pid:process.pid}))).listen(Number(process.env.PORT),"127.0.0.1");');
  const help = child(['--help']); help.stdin.end();
  assert.equal((await bounded(help.closed)).code, 0); assert.match(help.output, /previewhost serve/); assert.equal(help.errors, '');
  record('installed-inventory-and-cli-help', { node: process.version });

  runtime = await createPreviewRuntime({ allowedRoots: [site] });
  const start = await runtime.start({ name: 'embedded', type: 'static', directory: site });
  const ready = await runtime.wait('embedded', start.candidate.id);
  assert.equal(ready.state, 'ready'); assert.equal(await fetchText(ready.url), 'packaged-static');
  await runtime.close(); runtime = undefined; await gone(ready.url);
  record('clean-esm-library-static-start-fetch-close');

  const tokenFile = join(process.env.HOME, '.local/share/previewd/token');
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const existingToken = randomBytes(32).toString('hex');
  await writeFile(tokenFile, existingToken, { mode: 0o600 });
  daemon = child(['serve', '--root', site, '--allow-exec', '--port', '0']);
  await bounded(new Promise((resolve, reject) => {
    const inspect = () => { if (daemon.output.includes('\n')) { daemon.stdout.off('data', inspect); try { daemonInfo = JSON.parse(daemon.output.split('\n')[0]); resolve(); } catch (error) { reject(error); } } };
    daemon.stdout.on('data', inspect); daemon.once('close', () => reject(new Error('Daemon exited before readiness'))); inspect();
  }));
  assert.equal(daemonInfo.tokenFile, tokenFile);
  assert.equal(await readFile(tokenFile, 'utf8'), existingToken);
  const flags = ['--endpoint', daemonInfo.endpoint];
  client = connectPreviewDaemon({ endpoint: daemonInfo.endpoint });
  const filename = join(directory, 'static.json');
  await writeFile(filename, JSON.stringify({ name: 'cli-static', type: 'static', directory: site }));
  const cliReady = await cli(['start', '--file', filename, ...flags]);
  assert.equal(cliReady.state, 'ready'); assert.equal(await fetchText(cliReady.url), 'packaged-static');
  await cli(['stop', 'cli-static', ...flags]); await gone(cliReady.url);
  record('installed-cli-static-start-fetch-stop');

  const command = { name: 'cli-native', type: 'command', cwd: site, command: [process.execPath, 'server.mjs'] };
  await writeFile(join(directory, 'native.json'), JSON.stringify(command));
  const cliNative = await cli(['start', '--file', join(directory, 'native.json'), ...flags]);
  assert.equal(cliNative.state, 'ready');
  const cliApplication = JSON.parse(await fetchText(cliNative.url));
  assert.equal(cliApplication.message, 'packaged-native');
  record('installed-cli-native-start-fetch');

  // Match the documented GUI-host command/arguments with Node absent from PATH.
  rpcChild = child(['mcp', ...flags], true);
  const pending = new Map(); let next = 1; let buffer = '';
  rpcChild.stdout.on('data', (bytes) => {
    try {
      buffer += bytes.toString();
      assert(buffer.length <= 1_048_576, 'MCP response exceeded the fixture limit');
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const reply = JSON.parse(line); const waiter = pending.get(reply.id);
        if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result); }
      }
    } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear(); rpcChild.stdin.end();
    }
  });
  function rpc(method, params = {}) {
    const id = next++;
    const result = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
    rpcChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return bounded(result);
  }
  const initialization = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'previewhost-package-review', version: '1.0.0' } });
  assert.equal(initialization.serverInfo.name, 'previewhost');
  assert.equal(initialization.serverInfo.version, manifest.version);
  rpcChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await rpc('tools/list');
  assert.equal(tools.tools.length, 12);
  async function call(name, args) { const reply = await rpc('tools/call', { name, arguments: args }); assert.equal(reply.isError, undefined, JSON.stringify(reply)); return reply.structuredContent.result; }
  command.name = 'mcp-command';
  await call('preview_inspect', { spec: command });
  const candidate = await call('preview_start', { spec: command });
  const native = await call('preview_wait', { name: command.name, attemptId: candidate.candidate.id, timeoutMs: 5000 });
  assert.equal(native.state, 'ready');
  const application = JSON.parse(await fetchText(native.url));
  assert.equal(application.message, 'packaged-native');
  rpcChild.stdin.end(); assert.equal((await bounded(rpcChild.closed)).code, 0); assert.equal(rpcChild.errors, '');
  assert.deepEqual(JSON.parse(await fetchText(native.url)), application);
  await client.stop(command.name); await gone(native.url);
  assert.throws(() => process.kill(application.pid, 0), { code: 'ESRCH' });
  record('installed-mcp-absolute-node-minimal-path-discovery-start-disconnect-stop', { tools: tools.tools.length });
  await client.shutdown(); await client.close(); client = undefined;
  assert.equal((await bounded(daemon.closed)).code, 0); assert.equal(daemon.errors, '');
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  await gone(daemonInfo.endpoint);
  await gone(cliNative.url);
  assert.throws(() => process.kill(cliApplication.pid, 0), { code: 'ESRCH' });
  assert.equal(await readFile(tokenFile, 'utf8'), existingToken);
  record('daemon-shutdown-resource-cleanup', { existingPreviewdTokenReused: true });
} finally {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  await runtime?.close();
  if (client) { await client.shutdown().catch(() => {}); await client.close(); }
  for (const proc of children) proc.kill('SIGTERM');
  for (const proc of [...children]) { try { await bounded(proc.closed, 3000); } catch { proc.kill('SIGKILL'); await bounded(proc.closed, 3000); } }
}
