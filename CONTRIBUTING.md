# Contributing

## Set up development

Use Node.js 22.23 or later. POSIX native tests need `ps` and `lsof`.
On Debian or Ubuntu, install `procps` and `lsof` before the suite.
The tests use temporary source directories, loopback ports, and real child processes.
On macOS, the native Keychain build requires Xcode Command Line Tools (`clang` and `codesign`).
Terminal input tests use `/usr/bin/python3` to create and close temporary pseudo-terminals.

From the repository directory, run:

```sh
npm ci
npm run typecheck
npm test
git diff --check
npm pack --dry-run
```

`npm test` builds the package and runs the compiled Node tests one at a time.
POSIX fixtures run on macOS and Linux. Windows x64 and arm64 run the native, ownership, project, MCP, and package checks defined in CI.
Windows full-workflow and retained-data qualification remains incomplete. A skipped test does not establish platform support.
Some sandbox environments require explicit permission for local listeners and
process inspection.

Real database tests require local Docker Engine and cached database images.
If images are absent, pull them before the checks:

```sh
docker pull postgres:17-alpine
docker pull redis:7-alpine
```

Select your local Docker Unix socket (`/var/run/docker.sock` on standard Linux installations). The command below uses the Docker Desktop default:

```sh
PREVIEWHOST_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify
```

Without that variable, the real database suites skip. The remaining data tests
use isolated Unix sockets to exercise interrupted database operations and ownership checks.
Each real test creates its own containers and volumes, then removes only those
objects. Do not point verification at a shared or remote database.

Secret and database tests use disposable encrypted keystores through `src/testSupport/keystore.ts`.
Automatic-unlock tests use disposable macOS Keychains through `src/testSupport/keychain.ts`.
They never read personal credentials. The production helper accepts no test Keychain selector.

## Dashboard development

Follow [the dashboard design system](dashboard/DESIGN.md) for layout, components,
interaction states, and copy.

The React app lives in `dashboard/src/`. Vite bundles it into the CLI package;
users do not run a frontend development server. Tailwind maps the shared
`src/ui-tokens.css` palette to shadcn's semantic colors.

```sh
npm run build
node dist/cli.js dashboard
```

After frontend edits, run `npm run build:dashboard` and reopen the dashboard
command to load the new assets. Closing a dashboard leaves previews running.
Run `npm run typecheck` for both the runtime and React app.

Use the existing components in `dashboard/src/components/ui/`; add shadcn
components through the CLI and remove unused additions. Browser-check real
API interactions, keyboard navigation, both themes, and narrow screens.
The focused browser regression runs separately from the default Node suite:

```sh
npx playwright install chromium
npm run test:dashboard
```

Set `PREVIEWHOST_TEST_BROWSER` to a browser executable to use Brave instead.
The test creates disposable projects and real processes; it never reads personal
secrets. It disables traces and automatic screenshots to keep launch capabilities private.

## Build and install a tarball

Source builds require the tools listed in [Set up development](#set-up-development).
With GitHub access to the repository, clone the source:

```sh
git clone https://github.com/RojhatToptamus/previewhost.git
cd previewhost
```

Install build dependencies:

```sh
npm ci
```

Build the package and create a tarball:

```sh
npm pack
```

From your application directory, install that tarball.
Replace the path and `VERSION` with the file reported by `npm pack`:

```sh
npm install /absolute/path/to/previewhost/previewhost-VERSION.tgz
```

Installation from the tarball does not compile native code.
Continue with [First preview with the CLI](docs/first-preview.md).
Use `./node_modules/.bin/previewhost` for this local CLI installation.

## Verify a macOS release

See the [release pipeline](docs/releasing.md) for changesets, prerelease promotion,
GitHub Actions, and the one-time npm/GitHub setup.

Use the local Docker prerequisites above.
Replace the tarball placeholder with its actual path.
From the repository directory, run:

```sh
PREVIEWHOST_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify:release
npm pack --ignore-scripts
npm run check:package -- /absolute/path/to/previewhost-VERSION.tgz
```

`verify:release` requires macOS and an explicit local Docker Unix socket. It runs
the existing type check and full test suite. Missing images or an unavailable
Engine fail the existing database tests. Any skipped, canceled, failed, or TODO
test fails the release check, as does a missing test summary.

The package check installs that exact tarball in a temporary project outside this repository.
It rejects unexpected packaged files and checks the universal Keychain binary and signature.
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
Check the bundled skill references and local dashboard font assets too.

Base support claims on exercised workflows. Record the tested operating system,
Node version, framework, and agent client. Keep proposed support separate.
An SDK test alone does not establish host compatibility.

## Keep the repository small

Current behavior and maintained design rationale belong in tracked documentation.
Keep private reviews, temporary plans, fixtures, and raw verification artifacts in ignored `.local/`.
Curated product screenshots for the README belong in `assets/`.
Use disposable examples without credentials or private URLs.
Do not commit supplied designer specifications, HTML prototypes, or prototype runtime files.
Do not add credentials, tokens, generated output, or raw test artifacts to the package.

Before finishing a change, inspect the complete diff and package inventory.
Remove duplicated state, unused options, speculative abstractions, and stale docs.
If no current feature uses a timer, process, limit, or stored field, remove it.

The project uses the MIT license.
When you adapt external code, preserve required attribution in `LICENSE` and `NOTICE`.
