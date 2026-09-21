# Installation

Install Previewhost with npm. Check the Node.js, macOS, and Docker requirements for the features you need.

## Requirements

| Requirement | When you need it |
| --- | --- |
| macOS and Node.js 22.23 or later | Native commands, automatic owners, and managed databases. |
| `ps` and `lsof` | Native application commands use the macOS tools for process and listener checks. |
| macOS 13 or later | Optional automatic keystore unlock through Keychain. |
| An unlocked keystore | Stored secrets and managed database credentials. See [Secrets](secrets.md). |
| A local Docker Engine | Managed PostgreSQL and Redis only. See [Databases](databases.md#prepare-docker). |
| Your application's dependencies | Install these before startup, or declare [setup jobs](jobs.md). |

Password-only keystore access also has Linux test coverage. Windows remains unverified. This does not establish cross-platform preview support.

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

Before updating an existing installation, follow the [reset instructions](../README.md#reset-required-for-earlier-installations) for runtime storage and managed data.

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
Each restarted owner needs keystore unlock unless automatic unlock is available. See [secret access troubleshooting](troubleshooting.md#stored-secrets-are-missing-or-inaccessible).
