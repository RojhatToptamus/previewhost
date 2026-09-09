# previewd

Local HTTP previews for applications and coding agents.

previewd serves static files, runs development servers, and connects services
from separate repositories or worktrees. Applications and agent hosts can start,
inspect, replace, and stop previews through an ESM library, CLI, local HTTP API,
or MCP tools.

Each preview gets a local URL. An environment groups HTTP services and their
databases under one preview name. Replacement keeps the URL and switches
all application routes after the new services become ready.

## Install locally

This package is not published to npm. Build a tarball from this repository.

The initial release supports macOS and requires Node.js 22.23 or later.
Native commands require `/bin/ps` and `/usr/sbin/lsof`.
The package build requires Xcode Command Line Tools.
Stored secrets and managed databases require macOS 13 or later.
See [tested platforms and clients](docs/integrations.md).

Clone the repository and build the package:

```sh
git clone https://github.com/RojhatToptamus/previewd.git
cd previewd
npm ci
npm pack
```

From your application directory, install the generated tarball.
Replace `/absolute/path/to/previewd` with the repository path:

```sh
npm install /absolute/path/to/previewd/previewd-0.1.0.tgz
```

`npm pack` builds the package. Installation from the tarball does not compile
native code. For release verification, follow the [contribution guide](CONTRIBUTING.md#verify-a-macos-release).

## Start a static preview

From your application directory, start the daemon in the first terminal:

```sh
./node_modules/.bin/previewd serve --root "$PWD"
```

The daemon stays in the foreground. It prints its control endpoint and token
file path. CLI and MCP clients require this separate daemon.

In a second terminal, open the same application directory and run:

```sh
./node_modules/.bin/previewd start --file node_modules/previewd/examples/static.json
```

Open the `url` from the returned JSON in a browser.
It serves the packaged example page.
Source paths in a JSON or YAML file resolve relative to that file.

To stop the preview and shut down the daemon, run:

```sh
./node_modules/.bin/previewd stop example
./node_modules/.bin/previewd shutdown
```

A client disconnect leaves previews active. Stop preserves source files.
The [troubleshooting guide](docs/troubleshooting.md) covers port conflicts and connection errors.

## Run a development server

Native commands require permission to execute code as your user.
`--allow-exec` grants this permission and managed database operations, including explicit data deletion and recovery.
It does not provide a sandbox. Project dependencies must already exist.

After the previous daemon stops, run this command from your application directory:

```sh
./node_modules/.bin/previewd serve --root "$PWD" --allow-exec
```

In the second terminal, start the packaged Node server:

```sh
./node_modules/.bin/previewd start --file node_modules/previewd/examples/command.json
```

Open the returned `url`. The example needs no additional packages.
Commands receive `PORT`, `HOST=127.0.0.1`, and `PREVIEW_URL`.
See the [framework configurations](docs/integrations.md#framework-configuration) for Vite, Next.js, and Python.

To read logs and stop the example, run:

```sh
./node_modules/.bin/previewd logs node-example
./node_modules/.bin/previewd stop node-example
./node_modules/.bin/previewd shutdown
```

## Connect services from separate repositories

The [shared-notes example](examples/multi-repo/README.md) runs a frontend and two
backends with shared PostgreSQL and Redis data. Its guide includes dependencies,
startup, replacement, and cleanup.

Managed databases require local Docker Engine, cached images, an explicit private
`--data-dir`, and execution permission. Stop preserves their data.
`delete-data` permanently removes a stopped environment's owned data as a separate operation.
Attached HTTP servers and databases remain under their original owner.

For existing task worktrees, follow the [coding-task workflow](docs/worktrees.md).
The coding host owns source preparation and removal. Stop every preview that
uses a directory before the host removes it.

## Use agents, inputs, or stored secrets

- [Agent integration guide](docs/integrations.md): MCP configuration, tested clients, and approval behavior.
- [Environment bindings](docs/api.md#environment-specs): connect services and pass selected environment inputs.
- [Stored secrets](docs/api.md#stored-secrets): select Keychain entries and enter missing values through a private browser form.
- [Security guide](docs/security.md): execution permissions, secret access, and recovery limits.

previewd does not load `.env` files. Application commands can load their own files.
The daemon selects environment inputs and secret names before clients use them.

## Embed the library

From your application directory, save this code as `preview.mjs`.
It serves the packaged example, makes one HTTP request, and closes the runtime:

```js
import { fileURLToPath } from 'node:url';
import { createPreviewRuntime } from 'previewd';

const directory = fileURLToPath(new URL('./node_modules/previewd/examples/site', import.meta.url));
const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
try {
  const started = await runtime.start({ name: 'site', type: 'static', directory });
  const result = await runtime.wait('site', started.candidate.id);
  if (result.state !== 'ready') throw new Error(result.error?.message ?? result.state);
  console.log(result.url);
  console.log(await (await fetch(result.url)).text());
} finally {
  await runtime.close();
}
```

Run `node preview.mjs`. The output contains the URL and HTML.
For a long-lived application, keep the runtime open until application shutdown.
The embedded runtime does not require a separate daemon.
See the [API and CLI reference](docs/api.md) for configuration and lifecycle contracts.
For a TypeScript project, install `typescript` and `@types/node` as development dependencies.

## License

previewd uses the MIT license. The gateway and native supervisor adapt MIT-licensed
code from Task Monki. See [NOTICE](NOTICE) for attribution.
