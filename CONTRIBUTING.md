# Contributing

## Develop

Use Node.js 22.23 or later. Native tests need macOS with `ps` and `lsof`.
The tests use temporary source directories, loopback ports, and real child processes.
The native Keychain build requires Xcode Command Line Tools (`clang` and `codesign`).
Terminal regression tests use `/usr/bin/python3` to own disposable PTYs.

```sh
npm ci
npm run typecheck
npm test
git diff --check
npm pack --dry-run
```

`npm test` builds the package and runs colocated Node tests serially. Native tests
skip on unsupported platforms. A skipped test does not establish platform support.
Some sandbox environments require explicit permission for local listeners and
process inspection.

Real database tests require local Docker and cached `postgres:17-alpine` and
`redis:7-alpine` images. Select the local socket explicitly:

```sh
PREVIEWD_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify
```

Without that variable, the real database suites skip. The remaining data tests
use isolated Unix sockets to exercise interrupted mutations and ownership checks.
Each real test creates its own containers and volumes, then removes only those
objects. Do not point verification at a shared or remote database.

Secret and database tests use disposable Keychains through a test-only helper.
The fixture immediately restores and verifies the original Keychain search list.
It never reads personal credentials. Keep production Keychain access out of tests;
use `src/testSupport/keychain.ts` whenever a test can open managed data or secrets.
The production binary accepts no test Keychain selector.

## Verify a macOS release

Use the same local Docker prerequisites above, then run:

```sh
PREVIEWD_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify:release
npm pack --ignore-scripts
npm run check:package -- /absolute/path/to/previewd-0.1.0.tgz
```

`verify:release` requires macOS and an explicit local Docker Unix socket. It runs
the existing type check and full test suite. Missing images or an unavailable
Engine fail the existing database tests. Any skipped, canceled, failed, or TODO
test fails the release check, as does a missing test summary.

Pack only after that check passes; it has already built the package. The package
check installs that exact tarball in a temporary consumer outside this repository.
It checks public ESM imports, installed CLI static/native startup, MCP discovery
with an absolute Node executable and minimal PATH, disconnect survival, and cleanup.
It then installs TypeScript and Node declarations in the consumer and compiles
against the installed public declarations. npm needs registry access or cached dependencies.
On success, the check removes its temporary consumer after its owned processes close.
On failure, it retains that directory for diagnosis and cleanup verification.

Review `npm pack --dry-run` for unintended files. Current release evidence covers
macOS 26.5.1 on arm64. See [tested integrations](docs/integrations.md) for each
client's results and blockers. Headless and SDK checks do not establish
GUI compatibility.

## Change the product

Trace the public method, authoritative owner, and cleanup path before editing.
Prefer a small direct change. Keep runtime behavior in the library.
The daemon, CLI, and MCP adapter must call the same public methods.

Add tests for meaningful regressions. Use real processes and sockets when their
lifecycle is the risk. Every test must release its own temporary resources even
if an assertion fails. Never stop unrelated processes to make a test pass.

For a contract change, exercise the library, CLI, and MCP consumers. For a package
change, install a fresh tarball in a separate consumer. Verify its ESM import,
TypeScript declarations, executable, native supervisor path, and packaged Keychain helper.

Document only workflows that you exercise. Record the tested operating system,
Node version, framework, and agent client. Keep proposed support separate.
Do not infer real host compatibility from an SDK test alone.

## Keep the repository small

Current behavior belongs in tracked documentation. Research, private reviews,
plans, fixtures, benchmark results, and screenshots belong in ignored `.local/`.
Do not add credentials, tokens, generated output, or test artifacts to the package.

Before finishing a change, inspect the complete diff and package inventory.
Remove duplicated state, unused options, speculative abstractions, and stale docs.
Every retained timer, process, limit, and state field needs a current consumer.

The project uses the MIT license. Preserve required attribution in `LICENSE` and
`NOTICE` when you adapt external code.
