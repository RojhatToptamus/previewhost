# previewhost

Local HTTP previews for applications and coding agents.

previewhost serves static files, runs development servers, and connects services
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
git clone https://github.com/RojhatToptamus/previewhost.git
cd previewhost
npm ci
npm pack
```

For an existing `previewd` installation, read the [upgrade steps](#move-from-previewd) first.

From your application directory, install the generated tarball.
Replace `/absolute/path/to/previewhost` with the repository path:

```sh
npm install /absolute/path/to/previewhost/previewhost-0.1.0.tgz
```

`npm pack` builds the package. Installation from the tarball does not compile
native code. For release verification, follow the [contribution guide](CONTRIBUTING.md#verify-a-macos-release).

## Start a static preview

From your application directory, start the daemon in the first terminal:

```sh
./node_modules/.bin/previewhost serve --root "$PWD"
```

The daemon stays in the foreground. It prints its control endpoint and token
file path. CLI and MCP clients require this separate daemon.

In a second terminal, open the same application directory and run:

```sh
./node_modules/.bin/previewhost start --file node_modules/previewhost/examples/static.json
```

Open the `url` from the returned JSON in a browser.
It serves the packaged example page.
Source paths in a JSON or YAML file resolve relative to that file.

To stop the preview and shut down the daemon, run:

```sh
./node_modules/.bin/previewhost stop example
./node_modules/.bin/previewhost shutdown
```

A client disconnect leaves previews active. Stop preserves source files.
The [troubleshooting guide](docs/troubleshooting.md) covers port conflicts and connection errors.

## Run a development server

Native commands require permission to execute code as your user.
`--allow-exec` grants this permission and managed database operations, including explicit data deletion and recovery.
It does not provide a sandbox. Project dependencies must already exist.

After the previous daemon stops, run this command from your application directory:

```sh
./node_modules/.bin/previewhost serve --root "$PWD" --allow-exec
```

In the second terminal, start the packaged Node server:

```sh
./node_modules/.bin/previewhost start --file node_modules/previewhost/examples/command.json
```

Open the returned `url`. The example needs no additional packages.
Commands receive `PORT`, `HOST=127.0.0.1`, and `PREVIEW_URL`.
See the [framework configurations](docs/integrations.md#framework-configuration) for Vite, Next.js, and Python.

To read logs and stop the example, run:

```sh
./node_modules/.bin/previewhost logs node-example
./node_modules/.bin/previewhost stop node-example
./node_modules/.bin/previewhost shutdown
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

## Use the agent skill

The `previewhost` skill covers preview operation and recipe creation.
It uses one `SKILL.md` entrypoint and reads API, framework, database, and worktree references only when relevant.
For recipe decisions, see [Create or update a preview recipe](docs/recipes.md).

Install from a checkout that contains `skills/previewhost`.
From your application directory, use the existing [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add /absolute/path/to/previewhost --list
npx skills add /absolute/path/to/previewhost --skill previewhost --agent codex --yes
```

Replace `codex` with `claude-code`, `cursor`, or `opencode` for that client.
The commands use project scope. They do not install into your personal agent configuration.
The installer copies the skill into the project and creates client links where required.
Its file-copy behavior resolves the repository reference symlinks into ordinary files.
Those files reuse the maintained documentation and examples without requiring the source checkout at runtime.
This installation path does not establish support for other installers or copying methods.

| Client | Project discovery and invocation |
| --- | --- |
| [Codex CLI](https://developers.openai.com/codex/skills) | Reads `.agents/skills`. Use `$previewhost` or `/skills`. |
| [Claude Code](https://code.claude.com/docs/en/skills) | Reads `.claude/skills`. Use `/previewhost`. |
| [Cursor](https://cursor.com/docs/context/skills) | Reads `.agents/skills`. Select `/previewhost` in Agent chat. |
| [OpenCode](https://opencode.ai/docs/skills/) | Reads `.agents/skills`. Ask the agent to load the `previewhost` skill. |

An agent can also select the skill when the request matches its description.
For example: "Use previewhost to preview this project. Create a recipe if none exists, then verify the page."
Automatic selection depends on the client and task. Installation alone does not prove agent execution.

For a local-checkout installation, update the checkout and repeat the install command.
Once the skill is available on the repository's default branch, a Git installation can use:

```sh
npx skills add RojhatToptamus/previewhost --skill previewhost --agent codex --yes
```

Private repository access uses your existing Git authentication.
To refresh either installation, repeat its `skills add` command.
This also refreshes references when only the documentation or examples change.
Installed references do not track checkout edits automatically.
The skill does not install previewhost, start its daemon, configure MCP, or grant execution permission.
Install the package and configure the selected interface separately, as described in the [integration guide](docs/integrations.md).

## Use agents, inputs, or stored secrets

- [Agent integration guide](docs/integrations.md): MCP configuration, tested clients, and approval behavior.
- [Environment bindings](docs/api.md#environment-specs): connect services and pass selected environment inputs.
- [Stored secrets](docs/api.md#stored-secrets): select Keychain entries and enter missing values through a private browser form.
- [Security guide](docs/security.md): execution permissions, secret access, and recovery limits.

previewhost does not load `.env` files. Application commands can load their own files.
The daemon selects environment inputs and secret names before clients use them.

## Embed the library

From your application directory, save this code as `preview.mjs`.
It serves the packaged example, makes one HTTP request, and closes the runtime:

```js
import { fileURLToPath } from 'node:url';
import { createPreviewRuntime } from 'previewhost';

const directory = fileURLToPath(new URL('./node_modules/previewhost/examples/site', import.meta.url));
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

## Move from previewd

The package and command are now `previewhost`.
Update imports to `previewhost` and command paths to `node_modules/.bin/previewhost`.
Replace the MCP executable path and update server names and their permission rules together.
The library methods, HTTP routes, and `preview_*` tool names are unchanged.

With the existing endpoint and token arguments, run `./node_modules/.bin/previewd shutdown` from your application directory.
Start `./node_modules/.bin/previewhost serve` with the same roots, port, data directory, inputs, secret selections, and permissions.
For a custom token location, retain the same `--token-file` path.
The default remains `~/.local/share/previewd/token`.
No data-directory move or Keychain migration is required.

If data lives inside an installed package directory, retain that directory until you move the data separately.
See [retained storage identifiers](docs/security.md#retained-storage-identifiers).

## License

previewhost uses the MIT license. The gateway and native supervisor adapt MIT-licensed
code from Task Monki. See [NOTICE](NOTICE) for attribution.
