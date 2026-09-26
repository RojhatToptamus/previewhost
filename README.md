<p align="center">
  <img src="./assets/previewhost.svg" width="96" height="108" alt="Previewhost logo">
</p>

<h1 align="center">previewhost</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/previewhost">
    <img src="https://img.shields.io/npm/v/previewhost.svg?style=flat-square" alt="NPM version" />
  </a>
</p>

Previewhost runs local previews for full-stack apps.

Run multiple isolated previews side by side for different Git worktrees or repositories. Each preview can start your frontend, backend, databases, Redis, setup jobs, and other services together.

Previewhost assigns local URLs and ports, starts services in dependency order, and keeps managed data separate between environments. Use it from the dashboard, CLI, Node.js library, or through MCP with your coding agent.

Secrets stay as references in configuration and can be entered privately outside the agent chat. Service and job logs are available in one place.

![Fieldnotes preview with pinned projects, a frontend, API, PostgreSQL, Redis, and completed setup jobs](./assets/dashboard.png)

## Get started

Previewhost requires Node.js 22.23 or later.

```sh
npm install -g previewhost
```

Choose the interface you need:

| Interface | Guide |
| --- | --- |
| Dashboard | [Dashboard guide](docs/dashboard.md): choose a local folder, review its configuration, and start a preview. |
| Coding agent | [MCP setup](docs/mcp.md): register a client and ask it to preview your application. |
| Terminal | [First preview with the CLI](docs/first-preview.md): run a frontend and backend, replace them, and stop them. |
| Node.js program | [Node.js library](docs/library.md): start a runtime, request a page, and close it. |

Previewhost supports macOS, Linux, and Windows. See the [platform and database requirements](docs/installation.md#requirements) for architecture, system dependency, and database details.

For an existing installation, read the [reset instructions](#reset-required-for-earlier-installations) before updating.

Start with [installation](docs/installation.md) if Previewhost is not installed. The [introduction](docs/introduction.md) explains previews, environments, and project owners.

Default lookup uses root `preview.yaml`, then `preview.yml`. If both exist, select one with `--file` or keep one default.
New configurations save as `preview.yaml` only when neither file exists.

For a project with a configuration file and the global CLI installed:

```sh
previewhost inspect
previewhost start --allow-exec
previewhost dashboard
```

`--allow-exec` permits trusted commands and managed database operations with your user permissions, without a sandbox.

The dashboard opens in your browser. Use **New preview** to select a local folder and configuration, or **Configuration** to edit bindings and apply changes. Keep its terminal open; closing the dashboard does not stop previews.

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
| Start and manage previews in the browser | [Dashboard](docs/dashboard.md) |
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

Run `npm run dev:docs` to start the documentation site locally.

See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for the MIT license.
