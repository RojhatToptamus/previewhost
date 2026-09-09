# Contributing

## Set up development

Use Node.js 22.23 or later. Native tests need macOS with `ps` and `lsof`.
The tests use temporary source directories, loopback ports, and real child processes.
The native Keychain build requires Xcode Command Line Tools (`clang` and `codesign`).
Terminal input tests use `/usr/bin/python3` to create and close temporary pseudo-terminals.

From the repository directory, run:

```sh
npm ci
npm run typecheck
npm test
git diff --check
npm pack --dry-run
```

`npm test` builds the package and runs the Node tests beside their source files, one at a time.
Native tests skip on unsupported platforms. A skipped test does not establish platform support.
Some sandbox environments require explicit permission for local listeners and
process inspection.

Real database tests require local Docker Engine and cached database images.
If images are absent, pull them before the checks:

```sh
docker pull postgres:17-alpine
docker pull redis:7-alpine
```

Select your local Docker Unix socket. The command below uses the Docker Desktop default:

```sh
PREVIEWD_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify
```

`PREVIEWD_TEST_DOCKER_SOCKET` retains its existing name for development scripts.
Without that variable, the real database suites skip. The remaining data tests
use isolated Unix sockets to exercise interrupted database operations and ownership checks.
Each real test creates its own containers and volumes, then removes only those
objects. Do not point verification at a shared or remote database.

Secret and database tests use disposable Keychains through a test-only helper.
The fixture restores and checks the original Keychain search list immediately.
It never reads personal credentials.
For tests that open managed data or secrets, use `src/testSupport/keychain.ts`.
The production binary accepts no test Keychain selector.

## Verify a macOS release

Use the local Docker prerequisites above.
Replace the tarball placeholder with its actual path.
From the repository directory, run:

```sh
PREVIEWD_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify:release
npm pack --ignore-scripts
npm run check:package -- /absolute/path/to/previewhost-0.1.0.tgz
```

`verify:release` requires macOS and an explicit local Docker Unix socket. It runs
the existing type check and full test suite. Missing images or an unavailable
Engine fail the existing database tests. Any skipped, canceled, failed, or TODO
test fails the release check, as does a missing test summary.

The package check installs that exact tarball in a temporary project outside this repository.
It checks public ESM imports, installed CLI static/native startup, MCP discovery
with an absolute Node executable and minimal PATH, disconnect survival, and cleanup.
It then installs TypeScript and Node declarations in that project and compiles
against the installed public declarations.

npm requires registry access or cached dependencies.
On success, the check removes the temporary project after its test processes stop.
On failure, it retains that directory for diagnosis and cleanup verification.

Review `npm pack --dry-run` for unintended files. Current release evidence covers
macOS 26.5.1 on arm64. See [tested integrations](docs/integrations.md) for each
client's results and blockers. Headless and SDK checks do not establish desktop UI compatibility.

## Change the product

Before editing, trace the public method, its data, and its resource cleanup.
Prefer a small direct change. Keep runtime behavior in the library.
The daemon, CLI, and MCP adapter must call the same public methods.

Add tests for meaningful regressions.
For process or socket lifecycle risks, use real processes and sockets.
Each test must release its temporary resources, including after assertion failure.
Never stop unrelated processes to make a test pass.

For a contract change, exercise the library, CLI, and MCP consumers. For a package
change, install a fresh tarball in a separate project. Check its ESM import,
TypeScript declarations, executable, native supervisor path, and packaged Keychain helper.

Base support claims on exercised workflows. Record the tested operating system,
Node version, framework, and agent client. Keep proposed support separate.
An SDK test alone does not establish host compatibility.

## Keep the repository small

Current behavior belongs in tracked documentation. Research, private reviews,
plans, fixtures, benchmark results, and screenshots belong in ignored `.local/`.
Do not add credentials, tokens, generated output, or test artifacts to the package.

Before finishing a change, inspect the complete diff and package inventory.
Remove duplicated state, unused options, speculative abstractions, and stale docs.
If no current feature uses a timer, process, limit, or stored field, remove it.

The project uses the MIT license.
When you adapt external code, preserve required attribution in `LICENSE` and `NOTICE`.
