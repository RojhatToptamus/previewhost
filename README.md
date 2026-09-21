<p align="center">
  <img src="./assets/previewhost.svg" width="96" height="108" alt="Previewhost logo">
</p>

<h1 align="center">previewhost</h1>
  <p align="center">
    <a href="https://www.npmjs.com/package/previewhost">
      <img src="https://img.shields.io/npm/v/previewhost.svg?style=flat-square" alt="NPM version" />
    </a>
  </p>
Previewhost runs local previews of applications and their services.
Use it to try changes in separate worktrees or connect a frontend, APIs, and local databases across repositories.
It assigns ports, supplies service URLs, and runs setup jobs before dependent services start.

When you replace a preview, its local URL stays the same.
New requests switch only after the replacement services pass readiness checks.
Stop ends owned processes and retains managed database data.

![Previewhost dashboard showing a frontend, API, PostgreSQL, Redis, and completed migration and seed jobs](./assets/dashboard.png)

## Get started

Previewhost requires Node.js 22.23 or later on x64 or arm64.
Native commands, automatic project owners, and managed databases have macOS and Linux implementations.
Windows support is implemented but remains unverified; do not treat it as qualified for retained data yet.
Linux requires procps (`/bin/ps`) and `lsof` (`/usr/bin/lsof`).
Automatic unlock requires macOS 13 or later.

For an existing installation, read the [reset instructions](#reset-required-for-earlier-installations) before updating.

Choose the interface you need:

| Interface | Guide |
| --- | --- |
| Coding agent | [MCP setup](docs/mcp.md): register a client and ask it to preview your application. |
| Terminal | [First preview with the CLI](docs/first-preview.md): run a frontend and backend, replace them, and stop them. |
| Node.js program | [Node.js library](docs/library.md): start a runtime, request a page, and close it. |

Each guide includes its installation steps. The [introduction](docs/introduction.md) explains how previews, environments, and project owners work.

Default lookup uses root `preview.yaml`, then `preview.yml`. If both exist, select one with `--file` or keep one default.
New configurations save as `preview.yaml` only when neither file exists.

For a project with a configuration file and the global CLI installed:

```sh
previewhost inspect
previewhost start --allow-exec
previewhost dashboard
```

`--allow-exec` permits trusted commands and managed database operations with your user permissions, without a sandbox.
The dashboard opens in your browser and needs its terminal to remain open. Closing it does not stop previews.

## Documentation

| Task | Guide |
| --- | --- |
| Install or update Previewhost | [Installation](docs/installation.md) |
| Run a complete example | [First preview with the CLI](docs/first-preview.md) |
| Connect a coding agent | [MCP setup](docs/mcp.md) |
| Describe your application | [Write preview.yaml](docs/recipes.md) |
| Run services, migrations, and seeds | [Services and jobs](docs/jobs.md) |
| Connect or manage local data | [Databases](docs/databases.md) |
| Supply private credentials | [Secrets](docs/secrets.md) |
| Preview existing task checkouts | [Worktrees](docs/worktrees.md) |
| Inspect previews in the browser | [Dashboard](docs/dashboard.md) |
| Diagnose errors | [Troubleshooting](docs/troubleshooting.md) |
| Embed the runtime | [Node.js library](docs/library.md) |
| Look up fields and commands | [API and CLI reference](docs/api.md) |
| Check supported clients and frameworks | [Integrations](docs/integrations.md) |
| Understand permissions and recovery | [Security](docs/security.md) |

The [optional agent skill](https://github.com/RojhatToptamus/previewhost/blob/main/skills/previewhost/SKILL.md) ships in the npm package under
`dist/skills/previewhost`. Install it through your client's skill mechanism.
MCP registration and skill installation are separate operations.

## Reset required for earlier installations

This release uses `~/.local/share/previewhost` for runtime storage and Previewhost names for managed Docker resources.
It does not discover or migrate earlier runtime namespaces, Keychain secrets, or retained-data records. Existing files and resources are left intact.

1. Before updating, stop earlier Previewhost owners with the installed version.
2. If no encrypted keystore exists, run `previewhost secrets init`. Enter required secrets through [private input](docs/secrets.md#change-a-stored-value).
3. For new managed databases, choose a fresh `--data-dir`.
4. Keep old data directories, Docker volumes, and Keychain items until you decide how to retain them.

For valuable old database data, use the earlier release to access and export it first.
Use that release for any explicit cleanup of old data.
Removing a record or generating a new password does not recover its database.
See [keystore recovery](docs/troubleshooting.md#stored-secrets-are-missing-or-inaccessible) for backups and lost passwords.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for source builds and verification.
The [documentation website](https://github.com/RojhatToptamus/previewhost/blob/main/website/README.md) renders the same Markdown guides with
search, page outlines, and light and dark themes. Run `npm run dev:docs` after installing
repository dependencies. Website code and build output are excluded from the npm package. The bundled agent skill includes its referenced guides and product screenshots.

See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for the MIT license.
