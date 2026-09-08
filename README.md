# previewd

Local HTTP previews for applications and coding agents.

previewd serves static files, runs development servers across repositories, and
connects them to local PostgreSQL, Redis, or existing services. Each preview gets
a URL. An environment replaces its application routes together after every
candidate service is ready.

The TypeScript library owns the runtime. A foreground daemon shares that runtime
with the CLI and MCP tools. An application can use any interface without a model
API, provider account, or vendor SDK.

## Install locally

This repository is not published to npm. Install its local tarball.

The initial release targets macOS and needs Node.js 22.23 or later. Native commands
require `/bin/ps` and `/usr/sbin/lsof`. See [tested support](docs/integrations.md).
Stored secrets and managed database credentials require macOS 13 or later.
Building the packaged Keychain helper requires Xcode Command Line Tools.
Installing the tarball does not compile native code.

From this repository, run:

```sh
npm ci
npm run verify
npm pack
```

Developer verification can skip local Docker suites. For a release candidate, use
the [macOS release checks](CONTRIBUTING.md#verify-a-macos-release), which require zero skips
and test the tarball in a separate consumer.

From your application directory, install the generated tarball:

```sh
npm install /absolute/path/to/previewd/previewd-0.1.0.tgz
```

Use `./node_modules/.bin/previewd` from that directory. For a shell-wide command,
install the same tarball with `npm install --global /absolute/path/to/previewd-0.1.0.tgz`.

## Start a static preview

In one terminal, start the owner from your application directory:

```sh
./node_modules/.bin/previewd serve --root "$PWD"
```

The daemon stays in the foreground. Its output identifies the control endpoint
and token file. It does not start automatically from a client command.

In another terminal, use the packaged example:

```sh
./node_modules/.bin/previewd start --file node_modules/previewd/examples/static.json
./node_modules/.bin/previewd list
./node_modules/.bin/previewd stop example
./node_modules/.bin/previewd shutdown
```

`start` returns JSON with the ready URL. Open that URL in a browser.
Source paths in a JSON or YAML file resolve relative to that file.

## Run a development server

For trusted local code, start the daemon with execution permission:

```sh
./node_modules/.bin/previewd serve --root "$PWD" --allow-exec
```

Then run the packaged Node example:

```sh
./node_modules/.bin/previewd start --file node_modules/previewd/examples/command.json
./node_modules/.bin/previewd logs node-example
./node_modules/.bin/previewd stop node-example
```

`--allow-exec` grants ordinary execution as your user and explicit database
deletion/recovery operations. It is not a sandbox.
The command receives `PORT`, `HOST=127.0.0.1`, and `PREVIEW_URL`.
Dependencies must already exist. previewd does not install them.

## Run a multi-repository environment

An environment connects services from separate live directories. The numeric
URL reaches its `primary` service. Each HTTP service also gets a browser alias,
such as `shared-notes--api.localhost`, on the same preview port.

The packaged [multi-repository example](examples/multi-repo/README.md) contains a
frontend, two backends, PostgreSQL, and Redis. The backends share the same data.
Its README lists the Docker image prerequisites and startup commands.

```yaml
name: shop
type: environment
primary: web
services:
  database: {type: postgres}
  api:
    type: command
    cwd: ../backend
    command: [node, server.mjs]
    env:
      DATABASE_URL: {service: database}
      ALLOWED_ORIGIN: {browserUrl: web}
    readyPath: /ready
  web:
    type: command
    cwd: ../frontend
    command: [node, server.mjs]
    env:
      API_URL: {service: api}
      PUBLIC_API_URL: {browserUrl: api}
```

Managed databases require an explicit private `--data-dir`, local Docker Engine,
and execution permission. `--env NAME` selects an owner environment input for
`{fromEnv: NAME}` references. previewd does not load `.env` files. Application commands can.

Stop preserves database data. `previewd delete-data NAME` permanently removes a
stopped environment's owned data after host authorization. Attached databases
remain under their original owner.

## Preview existing task worktrees

Use the directories already supplied by the coding host, including uncommitted
changes and installed packages. Keep one preview name for the continuing task's
data. Stop all consuming previews before the host removes their source.

The [coding-task workflow](docs/worktrees.md) includes a runnable shared-notes
recipe for existing frontend/backend worktrees. It uses the current CLI or MCP
environment operations without another checkout or workspace owner.

## Supply stored secrets

Store an entry through hidden terminal input, then select its exact name for the daemon:

```sh
previewd secrets set shop/dev/token
previewd serve --root "$PWD" --allow-exec --secret shop/dev/token
```

Bind it only where needed in a command's `env`:

```yaml
API_TOKEN: {secret: shop/dev/token}
```

Values remain in individual macOS Keychain items. Names are ordinary visible
metadata, with no directory inheritance. Existing literals and `{fromEnv: NAME}`
remain available. `--allow-exec` selects no stored secrets by itself.

For missing entries, use `previewd secrets setup --file preview.yaml` or the
`preview_secrets_setup` MCP tool. The daemon opens a private local browser form.
Saving starts no code. Check setup status, then retry normal startup.
MCP receives names and status, never values or the form's write permission.
See [secret commands and limits](docs/api.md#stored-secrets) and the
[trust boundary](docs/security.md#stored-secrets-and-private-entry).

## Embed the library

```js
import { createPreviewRuntime } from 'previewd';

const runtime = await createPreviewRuntime({ allowedRoots: [process.cwd()] });
try {
  const started = await runtime.start({
    name: 'site', type: 'static', directory: process.cwd(),
  });
  const result = await runtime.wait('site', started.candidate.id);
  if (result.state !== 'ready') throw new Error(result.error?.message ?? result.state);
  console.log(result.url);
  console.log(await (await fetch(result.url)).text());
} finally {
  await runtime.close();
}
```

For a long-lived application, keep the runtime open until application shutdown.
The packaged [library example](examples/library.mjs) performs one request and then closes it.
`loadPreviewSpec(file)` uses the same JSON/YAML file loader as the CLI.
TypeScript consumers need TypeScript and `@types/node` as development dependencies.

## Behavior

- Names identify previews. Attempt IDs identify individual starts and replacements.
- Failed startup leaves no public listener. Candidate failure before replacement cutover keeps the active preview.
- If old-resource cleanup fails after cutover, the new route stays active and reports incomplete cleanup.
- Stop closes owned listeners, native process groups, and managed database containers. Database data remains available for the next start.
- Attached HTTP servers and databases remain running.
- Source directories remain live and caller-owned. Stop never deletes them.
- URLs stay stable across replacement, but can change after stop or daemon restart.
- A disconnected CLI or MCP client leaves daemon previews running.
- Application attempts and routes stay in memory. Restart does not restore native previews.
- Private data records retain exact database ownership. Recovery removes owned containers and preserves their volumes.
- An uncertain Docker creation can require operator recovery. Status retains the error and cleanup authority.

## Documentation

- [API and CLI reference](docs/api.md)
- [Agent clients, frameworks, and tested support](docs/integrations.md)
- [Existing coding-task worktrees](docs/worktrees.md)
- [Ownership, security, and recovery](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contribution guide](CONTRIBUTING.md)

The gateway and native supervisor adapt narrow MIT-licensed Task Monki behavior.
See [NOTICE](NOTICE). previewd does not include the Task Monki workflow engine.
