# Installation

Install the CLI for terminal and MCP use, or add Previewhost to a Node.js project for library imports.

## Requirements

| Requirement | When you need it |
| --- | --- |
| macOS and Node.js 22.23 or later | The supported Previewhost runtime. Linux and Windows remain unverified. |
| `ps` and `lsof` | Native application commands use the macOS tools for process and listener checks. |
| macOS 13 or later | Stored secrets and managed database credentials use Keychain. |
| A local Docker Engine | Managed PostgreSQL and Redis only. See [Databases](databases.md#prepare-docker). |
| Your application's dependencies | Install these before startup, or declare [setup jobs](jobs.md). |

The published npm package includes the native helper. Installation needs no compiler or GitHub access.

## Install the CLI

Run these commands in your terminal:

```sh
npm install -g previewhost
previewhost --version
previewhost --help
```

Choose [First preview with the CLI](first-preview.md) for terminal use or [MCP setup](mcp.md) for a coding agent.
If your editor cannot find the executable, follow the [PATH troubleshooting steps](troubleshooting.md#the-client-cannot-find-previewhost).

## Install in a project

For library imports or a project-specific CLI, run this from the application directory:

```sh
npm install previewhost
./node_modules/.bin/previewhost --version
```

Use `./node_modules/.bin/previewhost` instead of `previewhost` in the guides that follow.
See the [library guide](library.md) for a complete program.

## Update an installation

For a global installation:

```sh
npm install -g previewhost
previewhost --version
```

Existing project owners keep their loaded version.
When you can stop their previews, run this from each affected project:

```sh
previewhost shutdown
```

Then start the preview again. Managed data and stored values remain, but owner shutdown ends secret access approvals.
An updated Keychain helper can need approval again. See [secret access troubleshooting](troubleshooting.md#stored-secrets-are-missing-or-inaccessible).
