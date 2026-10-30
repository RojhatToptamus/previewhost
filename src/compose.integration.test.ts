import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import type { ComposeSpec, PreviewSpec, PreviewStatus, RuntimeOptions } from './contracts.js';
import { PreviewError } from './errors.js';
import { ComposeCli } from './compose-cli.js';
import { prepareCompose } from './compose-inspection.js';

const dockerSocket = process.env.PREVIEWHOST_TEST_DOCKER_SOCKET;
async function settle(runtime: PreviewRuntime, status: PreviewStatus, signal: AbortSignal) {
  for (;;) {
    try { return await runtime.wait(status.name, status.candidate!.id, { signal }); }
    catch (error) {
      // A wait window can expire while the same attempt is still running. The test deadline bounds observation.
      if (error instanceof PreviewError && error.code === 'TIMEOUT') continue;
      throw new Error(JSON.stringify({ status: await runtime.get(status.name), logs: await runtime.logs(status.name, status.candidate!.id) }), { cause: error });
    }
  }
}

test('Compose replacements, failures, cancellation and restart keep exact volume ownership and isolate another environment', {
  skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET and local busybox:1.37', timeout: 360000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const options: RuntimeOptions = { allowedRoots: [source], dataDirectory: join(directory, 'data'), stateDirectory: join(directory, 'state'),
    keystoreDirectory: join(directory, 'keystore'), dockerSocket, authorize: () => true };
  let runtime = await createPreviewRuntime(options);
  t.after(async () => {
    for (const status of await runtime.list()) {
      await runtime.stop(status.name);
      if ((await runtime.get(status.name)).data) await runtime.deleteData(status.name);
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const write = async (value: string, fail = false, wait = false) => writeFile(join(source, 'compose.json'), JSON.stringify({
    services: { web: { image: 'busybox:1.37', command: ['sh', '-c', 'if [ "$$FAIL" = yes ]; then exit 9; fi; if [ "$$WAIT" = yes ]; then sleep 120; fi; if [ ! -f /data/index.html ]; then echo "$$VALUE" > /data/index.html; fi; echo "app-log:$$TOKEN"; exec httpd -f -p 8080 -h /data'],
      expose: [8080], environment: { VALUE: value, FAIL: fail ? 'yes' : 'no', WAIT: wait ? 'yes' : 'no', TOKEN: 'SYNTHETIC_COMPOSE_PRIVATE_VALUE_2026' }, volumes: ['notes:/data'] } },
    volumes: { notes: {} },
  }));
  const spec = (name: string): PreviewSpec => ({ name, type: 'compose', cwd: source, files: ['compose.json'], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } }, ready: { type: 'http', port: 'http', path: '/', timeoutMs: 3000 } }],
    primary: { service: 'web', port: 'http' } });
  await write('first');
  const first = await settle(runtime, await runtime.start(spec('one')), t.signal);
  assert.equal(first.state, 'ready', JSON.stringify({ result: first, logs: await runtime.logs('one', first.id) }));
  assert.equal((await (await fetch(first.url!)).text()).trim(), 'first');
  await write('second');
  const second = await settle(runtime, await runtime.start(spec('two')), t.signal);
  assert.equal(second.state, 'ready', JSON.stringify(second));
  assert.equal((await (await fetch(second.url!)).text()).trim(), 'second');
  const replacementStarted = performance.now();
  const replacement = await settle(runtime, await runtime.replace('one', spec('one')), t.signal);
  t.diagnostic(`Compose replacement including old-container cleanup: ${Math.round(performance.now() - replacementStarted)} ms`);
  assert.equal(replacement.state, 'ready', JSON.stringify({ result: replacement, logs: await runtime.logs('one', replacement.id) }));
  assert.equal(replacement.url, first.url);
  assert.equal((await (await fetch(replacement.url!)).text()).trim(), 'first');
  assert.doesNotMatch(JSON.stringify(await runtime.describe('one', replacement.id)), /SYNTHETIC_COMPOSE_PRIVATE_VALUE_2026/);
  const deadline = Date.now() + 5000;
  while (!(await runtime.logs('one', replacement.id, { source: 'web' })).text.includes('app-log:')) { assert.ok(Date.now() < deadline, 'Container output was not captured'); await delay(25); }
  assert.match((await runtime.logs('one', replacement.id, { source: 'web' })).text, /app-log:\[REDACTED\]/);
  assert.doesNotMatch((await runtime.logs('one', replacement.id)).text, /SYNTHETIC_COMPOSE_PRIVATE_VALUE_2026/);
  await write('ignored', true);
  const failed = await settle(runtime, await runtime.replace('one', spec('one')), t.signal);
  assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal((await runtime.get('one')).active, undefined, 'An in-place data update must not claim the stopped application still serves');
  assert.equal((await fetch(second.url!)).status, 200);
  await write('ignored', false, true);
  const candidate = await runtime.start(spec('one'));
  // Reaching the started container takes a whole Compose start, as long as the Docker host needs. The attempt's own
  // startup deadline bounds the wait: the test fails as soon as the candidate stops starting without it.
  while (!(await runtime.logs('one', candidate.candidate!.id)).text.includes('Started')) {
    const status = await runtime.get('one');
    if (status.candidate?.id !== candidate.candidate!.id || status.candidate.state !== 'starting') {
      assert.fail(`The candidate stopped before its container started: ${JSON.stringify({ status, logs: await runtime.logs('one', candidate.candidate!.id) })}`);
    }
    await delay(50);
  }
  await runtime.cancel('one', candidate.candidate!.id);
  assert.equal((await runtime.get('one')).latest?.state, 'canceled');
  await write('ignored');
  await runtime.close();
  runtime = await createPreviewRuntime(options);
  assert.equal((await runtime.get('two')).active, undefined);
  const restarted = await settle(runtime, await runtime.start(spec('one')), t.signal);
  assert.equal(restarted.state, 'ready', JSON.stringify(restarted));
  assert.equal((await (await fetch(restarted.url!)).text()).trim(), 'first');
  await runtime.stop('one');
  await runtime.deleteData('one');
  assert.equal((await runtime.get('one')).data, undefined);
  assert.deepEqual((await runtime.get('two')).data?.resources, [{ name: 'notes', type: 'compose-volume' }]);
});

test('Compose normalizes private copies, so env and secret files swapped for links after inspection are never read', {
  skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET and the Docker Compose CLI',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-inputs-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const cli = await ComposeCli.create(directory, dockerSocket!);
  t.after(async () => { await cli.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'outside.env'), 'VALUE=outside\n');
  await writeFile(join(directory, 'outside-secret'), 'outside-secret');
  await writeFile(join(source, 'app.env'), 'VALUE=original\n');
  await writeFile(join(source, 'token'), 'original-secret');
  await writeFile(join(source, 'compose.yaml'), 'services:\n  web:\n    image: busybox:1.37\n    env_file: app.env\n    secrets: [token]\n    expose: [8080]\nsecrets:\n  token:\n    file: token\n');
  const spec: ComposeSpec = { name: 'inputs', type: 'compose', cwd: source, files: ['compose.yaml'], profiles: [], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } } }], primary: { service: 'web', port: 'http' }, routes: {}, timeoutMs: 120000 };
  // Each file passed inspection's checks. Replace both with links out of the source before Compose runs.
  let swapped = false;
  const racing = Object.assign(Object.create(cli), {
    async config(...args: Parameters<ComposeCli['config']>) {
      if (!swapped) {
        swapped = true;
        for (const [file, outside] of [['app.env', 'outside.env'], ['token', 'outside-secret']]) {
          await rm(join(source, file));
          await symlink(join(directory, outside), join(source, file));
        }
      }
      return cli.config(...args);
    },
  }) as ComposeCli;
  const prepared = await prepareCompose(spec, racing, t.signal);
  assert.ok(swapped);
  const services = prepared.configuration.services as Record<string, { environment: Record<string, string> }>;
  assert.equal(services.web.environment.VALUE, 'original');
  const secret = (prepared.configuration.secrets as Record<string, { file: string }>).token.file;
  assert.ok(secret.startsWith(cli.directory), secret);
  assert.equal(await readFile(secret, 'utf8'), 'original-secret');
  assert.ok(prepared.redactions.includes('original-secret'));
  assert.doesNotMatch(JSON.stringify(prepared), /outside/);
});

test('Compose builds from a root context with the Dockerfile and ignore file it inspected, even when a link replaces the Dockerfile before the build', {
  skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET and local busybox:1.37', timeout: 240000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-build-'));
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(join(source, 'index.html'), 'inspected');
  await writeFile(join(source, 'excluded.txt'), 'excluded');
  await writeFile(join(source, 'swapped.html'), 'swapped');
  const command = 'CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n';
  await writeFile(join(source, 'Dockerfile'), `FROM busybox:1.37\nCOPY . /www\n${command}`);
  // Docker reads this ignore file beside the Dockerfile, so it must sit beside the private copy too.
  await writeFile(join(source, 'Dockerfile.dockerignore'), 'excluded.txt\n');
  await writeFile(join(directory, 'outside.Dockerfile'), `FROM busybox:1.37\nCOPY swapped.html /www/index.html\n${command}`);
  await writeFile(join(source, 'compose.yaml'), 'services:\n  web:\n    build: .\n    expose: [8080]\n');
  // Authorization runs after inspection and before Docker reads the Dockerfile.
  const runtime = await createPreviewRuntime({ allowedRoots: [source], dataDirectory: join(directory, 'data'), keystoreDirectory: join(directory, 'keystore'), dockerSocket,
    authorize: async request => {
      if (request.operation === 'start') { await rm(join(source, 'Dockerfile')); await symlink(join(directory, 'outside.Dockerfile'), join(source, 'Dockerfile')); }
      return true;
    } });
  t.after(async () => {
    await runtime.stop('build').catch(() => {});
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await settle(runtime, await runtime.start({ name: 'build', type: 'compose', cwd: source, files: ['compose.yaml'], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } }, ready: { type: 'http', port: 'http', path: '/', timeoutMs: 10000 } }],
    primary: { service: 'web', port: 'http' } }), t.signal);
  assert.equal(result.state, 'ready', JSON.stringify({ result, logs: await runtime.logs('build', result.id) }));
  assert.equal((await (await fetch(result.url!)).text()).trim(), 'inspected');
  assert.equal((await fetch(new URL('/excluded.txt', result.url!))).status, 404);
});

test('Compose pins build contexts to verified absolute directories and Dockerfiles to private copies', {
  skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET and the Docker Compose CLI',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-context-'));
  const source = join(directory, 'source');
  // A relative context with this name would be a Git remote to Docker.
  const context = join(source, 'github.com/x/y');
  await mkdir(context, { recursive: true });
  await writeFile(join(context, 'Dockerfile'), 'FROM busybox:1.37\n');
  await writeFile(join(source, 'compose.yaml'), 'services:\n  web:\n    build: github.com/x/y\n    expose: [8080]\n');
  const cli = await ComposeCli.create(directory, dockerSocket!);
  t.after(async () => { await cli.close(); await rm(directory, { recursive: true, force: true }); });
  const spec: ComposeSpec = { name: 'context', type: 'compose', cwd: source, files: ['compose.yaml'], profiles: [], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } } }], primary: { service: 'web', port: 'http' }, routes: {}, timeoutMs: 120000 };
  const prepared = await prepareCompose(spec, cli, t.signal);
  const build = (prepared.configuration.services as Record<string, { build: { context: string; dockerfile: string } }>).web.build;
  assert.equal(build.context, await realpath(context));
  assert.ok(build.dockerfile.startsWith(cli.directory), build.dockerfile);
  assert.equal(await readFile(build.dockerfile, 'utf8'), 'FROM busybox:1.37\n');
  assert.deepEqual(prepared.description.services[0].build, { context: 'github.com/x/y', dockerfile: 'Dockerfile' });
});

test('a Dockerfile-specific ignore file, even an empty one, is kept for BuildKit and refused where Compose would use the legacy builder', {
  skip: !dockerSocket && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET, the Docker Compose CLI and Docker Buildx',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-ignore-'));
  const source = join(directory, 'source');
  await mkdir(source);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(source, 'Dockerfile'), 'FROM busybox:1.37\n');
  await writeFile(join(source, 'compose.yaml'), 'services:\n  web:\n    build: .\n    expose: [8080]\n');
  const spec: ComposeSpec = { name: 'ignore', type: 'compose', cwd: source, files: ['compose.yaml'], profiles: [], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } } }], primary: { service: 'web', port: 'http' }, routes: {}, timeoutMs: 120000 };
  // Each preparation writes its copies into a command directory of its own.
  // `without` reports a Compose version and no Buildx plugin, as Compose would find them.
  const commandDirectory = async (without?: { compose: string }) => {
    const cli = await ComposeCli.create(directory, dockerSocket!);
    t.after(() => cli.close());
    if (!without) return cli;
    return Object.assign(Object.create(cli), { probe: async (signal: AbortSignal) => { await cli.probe(signal); return without.compose; }, buildx: async () => false }) as ComposeCli;
  };
  // Without an ignore file of its own, every builder applies the context's .dockerignore.
  await prepareCompose(spec, await commandDirectory({ compose: '5.5.0' }), t.signal);
  await writeFile(join(source, 'Dockerfile.dockerignore'), '');
  // Compose 5 without Buildx uses the legacy builder; Compose 2 falls back to its own BuildKit client.
  await assert.rejects(prepareCompose(spec, await commandDirectory({ compose: '5.5.0' }), t.signal), /Install Docker Buildx/);
  await prepareCompose(spec, await commandDirectory({ compose: '2.40.3' }), t.signal);
  const prepared = await prepareCompose(spec, await commandDirectory(), t.signal);
  const build = (prepared.configuration.services as Record<string, { build: { dockerfile: string } }>).web.build;
  assert.equal(await readFile(`${build.dockerfile}.dockerignore`, 'utf8'), '');
});

test('Compose image builds are refused while application commands run through an embedder', {
  skip: (!dockerSocket || process.platform === 'win32') && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET on macOS or Linux',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-compose-embedded-'));
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(join(source, 'Dockerfile'), 'FROM busybox:1.37\n');
  await writeFile(join(source, 'compose.yaml'), 'services:\n  web:\n    build: .\n    expose: [8080]\n');
  const runtime = await createPreviewRuntime({ allowedRoots: [source], dataDirectory: join(directory, 'data'), keystoreDirectory: join(directory, 'keystore'), dockerSocket,
    authorize: () => true, applicationProcesses: { baseEnvironment: { PATH: '/usr/bin:/bin' }, start: () => Promise.reject(new Error('Compose must not use the embedder.')) } });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await settle(runtime, await runtime.start({ name: 'embedded', type: 'compose', cwd: source, files: ['compose.yaml'], rootServices: ['web'],
    services: [{ id: 'web', ports: { http: { target: 8080 } } }], primary: { service: 'web', port: 'http' } }), t.signal);
  assert.equal(result.state, 'failed');
  assert.equal(result.error?.code, 'INVALID_INPUT');
  assert.match(result.error!.message, /Builds are unavailable while application commands run through applicationProcesses/);
});
