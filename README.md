# previewd

Local HTTP previews for applications and coding agents.

previewd serves static files, runs a development server, or attaches to an existing
loopback server. Each preview gets a URL. Replacement keeps that URL and changes
the route only after the candidate is ready.

The TypeScript library owns the runtime. A foreground daemon shares that runtime
with the CLI and MCP tools. An application can use any interface without a model
API, provider account, or vendor SDK.

## Install locally

This repository is not published to npm. Install its local tarball.

Requirements: Node.js 22.23 or later. Native commands currently require macOS,
`/bin/ps`, and `/usr/sbin/lsof`. See [tested support](docs/integrations.md).

From this repository, run:

```sh
npm ci
npm run verify
npm pack
```

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
Source paths in a JSON file resolve relative to that file.

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

`--allow-exec` grants ordinary execution as your user. It is not a sandbox.
The command receives `PORT`, `HOST=127.0.0.1`, and `PREVIEW_URL`.
Dependencies must already exist. previewd does not install them.

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

## Behavior

- Names identify previews. Attempt IDs identify individual starts and replacements.
- Failed startup leaves no public listener. Candidate failure before replacement cutover keeps the active preview.
- If old-resource cleanup fails after cutover, the new route stays active and reports incomplete cleanup.
- Stop closes owned listeners and native process groups. Attached servers remain running.
- Source directories remain live and caller-owned. Stop never deletes them.
- URLs stay stable across replacement, but can change after stop or daemon restart.
- A disconnected CLI or MCP client leaves daemon previews running.
- Runtime state stays in memory. Restart does not restore previews or adopt old processes.

## Documentation

- [API and CLI reference](docs/api.md)
- [Agent clients, frameworks, and tested support](docs/integrations.md)
- [Ownership, security, and recovery](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contribution guide](CONTRIBUTING.md)

The gateway and native supervisor adapt narrow MIT-licensed Task Monki behavior.
See [NOTICE](NOTICE). previewd does not include the Task Monki workflow engine.
