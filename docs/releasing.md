# Releases

previewhost uses Changesets 3 and GitHub Actions. Regular releases publish to `latest`.
If prerelease mode is enabled again, `.changeset/pre.json` selects its channel; leaving it requires explicit maintainer approval.

## Make a release

1. Implement and verify the change on a branch.
2. Run `npm run changeset`. Select `previewhost`, choose the version change,
   and describe the user-visible result. Include that changeset in the PR.
3. Merge the PR into `main`. The Release workflow creates or updates
   `changeset-release/main`, with the version, lockfile, and changelog changes.
4. On that release PR, select **Approve workflows to run** when GitHub requests it.
   Review the changelog and wait for **Verify macOS package** to pass.
5. Merge the release PR. Release verifies the merged source, publishes the
   verified tarball to npm, and creates a GitHub release with changelog notes. Alpha versions are marked as prereleases.

Use patch for fixes, minor for features, and major for breaking changes.
During `0.x` development, use minor for breaking changes and include the required upgrade steps in the release notes.
Prerelease numbering follows Changesets. Review the generated version in the release PR.
Regular releases use `npm install previewhost`. Alpha releases use `npm install previewhost@alpha`.
Do not change the package version or npm tag by hand for normal releases.

Documentation and tooling changes that do not affect the package need no changeset.
During prerelease mode, consumed changesets stay under `.changeset/pre/` until promotion includes them in the regular changelog.

## What runs

`.github/workflows/ci.yml` runs for PRs targeting `main`. Release also calls it
before publication. Documentation and type checks run on Ubuntu. Native tests and
package checks run on macOS. Two macOS database jobs each start a separate Colima
engine and run their assigned files serially.

`scripts/test-groups.mjs` lists database files and discovers the native remainder.
Every discovered file runs once. Each group requires a complete TAP summary with
zero skipped, failed, canceled, or TODO tests. Database groups require an explicit
local Docker socket. New database tests must report a skip or error when Docker
is absent; they must never silently omit cases.

**Verify macOS package** requires all three job types to succeed. Missing, skipped,
canceled, or failed dependencies block publication. `npm run verify:release`
retains the complete serial suite for local verification and comparison.

The runner is `macos-15-intel`, which Colima uses in its own integration workflow.
Colima uses the native macOS VZ backend with four virtual CPUs. Docker tool installation,
VM startup, and image pulls have separate CI steps so their durations are visible.
The full suite retains its normal timeouts and the zero-skip release gate.
PR updates cancel superseded CI runs. Release runs retain their existing serialization and are not canceled by this rule.
Native compilation requires Xcode Command Line Tools. The build produces one
ad-hoc signed Keychain helper with `arm64` and `x86_64` slices. Consumers do not
compile it during installation. CI uses Node.js 24; the package minimum remains
Node.js 22.23. Local arm64 results do not establish hosted Intel compatibility.

For a release, CI downloads the Changesets publish plan and verifies its package and version.
It selects `alpha` for alpha versions and `latest` for regular versions before packing.
This explicit selection handles npm's first-alpha `latest` tag without relying on its removal.
Changesets packs the completed build with lifecycle scripts disabled.
`npm run check:package` installs that exact tarball outside the repository. It checks
its inventory, both native architectures, code signature, executable permissions,
ESM imports, CLI startup, MCP discovery and version, cleanup, and TypeScript declarations.
After these checks pass, CI uploads the packed directory for the publish job to consume by artifact ID.
The publisher runs on hosted Ubuntu and does not rebuild or repack the source.

The publish job alone receives `id-token: write`. It uses npm 11 for Trusted
Publishing and `contents: write` for tags and GitHub releases. The prepare job uses
`contents: write` and `pull-requests: write` for release PRs. Verification gets only
`contents: read`. Release runs are serialized and are not canceled during publication.

The npm allowlist includes compiled JavaScript and declarations, the native helper,
bundled dashboard fonts and their license, README examples, README, LICENSE, NOTICE, and package metadata.
It also includes the agent skill and its materialized documentation, example, and asset references.
`scripts/prepare-bin.mjs` selects those references; research reports are excluded.
Top-level docs, CONTRIBUTING, changelogs, changesets, workflows, source, tests, and local data are excluded.
Do not put credentials or private material in README or source that compiles into `dist/`.

## One-time setup

These steps need a repository administrator and an npm account permitted to
publish the unscoped public package `previewhost`. No npm token is stored in GitHub.
The first npm publication is manual because [npm requires an existing package](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)
before Trusted Publishing can be configured. Recheck name availability immediately before that publication.

### GitHub settings

1. Merge these workflow files into `main` through a reviewed PR.
2. Open **Settings → Actions → General**. Allow the GitHub and Changesets actions
   used here. Under **Workflow permissions**, enable
   **Allow GitHub Actions to create and approve pull requests**.
   The workflow files request their required write permissions explicitly.
3. After CI has run, protect `main` and require its **Verify macOS package** check.
   Select the emitted check name in GitHub; the reusable release job has a nested name.
   Have a maintainer review and merge release PRs.

The standard `GITHUB_TOKEN` is sufficient for PR creation, tags, and releases.
GitHub currently creates approval-required CI runs when this token opens or updates
a PR. A user with write access must select **Approve workflows to run** on each
release PR update that requests it. Ordinary PRs follow GitHub's normal approval rules.

For release PR checks with no approval prompt, use a GitHub App installation token
or a fine-grained personal token instead. Limit it to this repository with
**Contents: Read and write** and **Pull requests: Read and write**.
For an App, store its app ID and private key as repository secrets and generate an
installation token during the workflow. For a personal token, store the token as a
repository secret. Pass the resulting token as `github-token` to
`changesets/action/version`. Neither alternative is required or configured here.

### Bootstrap `0.1.0-alpha.0`

On a Mac, check out the merged release source and install its dependencies.
Prepare the local Docker images described in [Contributing](../CONTRIBUTING.md).
Then run:

```sh
npm ci
PREVIEWHOST_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify:release
npm pack --ignore-scripts
npm run check:package -- "$PWD/previewhost-0.1.0-alpha.0.tgz"
npm publish ./previewhost-0.1.0-alpha.0.tgz --dry-run --ignore-scripts --access public --tag alpha
```

Review the package inventory. When ready to publish, authenticate interactively
with `npm login` and complete npm's browser/2FA prompts. Then publish the checked file:

```sh
npm publish ./previewhost-0.1.0-alpha.0.tgz --ignore-scripts --access public --tag alpha
npm view previewhost@alpha dist-tags --json
```

Confirm that `alpha` points to `0.1.0-alpha.0`.
npm can also assign `latest` to this first alpha and reject its removal.
Changesets then defaults subsequent alpha releases to `latest`.
The workflow overrides that default from the package version before packing, so alpha releases update only `alpha`.
An existing `latest` tag remains until a separate tag change or regular release.
The first registry publication and its resulting tags must be checked live.

Create the initial GitHub prerelease from the same source commit, using the
`0.1.0-alpha.0` changelog entry as its notes. Use tag `v0.1.0-alpha.0`.
This bootstrap release is manual; subsequent releases are automatic.
Merging these workflows before bootstrap may produce a failed OIDC attempt;
that does not create an npm package. Complete bootstrap before merging another
package changeset.

### npm Trusted Publishing

After bootstrap, open the `previewhost` package on npm, then
**Settings → Trusted publishing → Add trusted publisher → GitHub Actions**.
Set:

| Field | Value |
| --- | --- |
| Organization or user | `RojhatToptamus` |
| Repository | `previewhost` |
| Workflow filename | `release.yml` |
| Environment name | Leave empty; this workflow uses no environment |
| Allowed actions | Enable direct `npm publish` |

New trust entries default to staged publishing. Direct `npm publish` must be
allowed for this automatic pipeline. Changesets does not support npm's staged
publishing flow. Do not enter `.github/workflows/release.yml` in the filename field.
The `repository.url` in `package.json` already identifies the correct repository.

Under **Publishing access**, select
**Require two-factor authentication and disallow tokens**. Trusted Publishing
continues to work with this setting. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` secrets.
OIDC is available only on supported hosted runners, which this workflow uses.

The repository is public. npm can generate provenance for public-package OIDC publications
from GitHub Actions. Verify it on the published package; see the
[provenance requirements](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation).
Changing repository visibility is a separate decision.

## Promote to a regular release

When prerelease mode is active, run on a branch:

```sh
npm run changeset -- pre exit
```

Review the retained `.changeset/pre/` notes and include the exit change in a PR.
After it merges, Changesets opens a regular release PR. Review its version and
changelog, approve its CI if requested, and merge it to publish to `latest`.
The initial alpha series was promoted to `0.1.0`.
The release workflow derives the expected tag from the version, so no workflow
edit is needed. Existing `alpha` tags remain until deliberately changed.

## Failures and verification limits

A failing test, native check, inventory check, or release-plan validation blocks publication.
For a test/build failure, fix the cause and rerun Release on `main`.
Do not bypass the zero-skip release gate.

If publication or GitHub release creation fails, first inspect
`npm view previewhost versions dist-tags --json` and the GitHub release.
Use `npm view previewhost@<version> --json` to check the attempted version directly.
An npm version cannot be overwritten. If npm already has the version, repair only
the missing tag or GitHub release after confirming the original source commit.
A rerun of Changesets may skip an already-published version; it does not guarantee
repair of a missing GitHub release. Never republish changed bytes under that version.

Local validation can exercise the full macOS suite, package contents, installed
consumers, Changesets versioning, and a publish dry run. It cannot establish
hosted runner behavior, repository permission settings, release PR events,
OIDC authentication, registry dist-tags, or GitHub release creation.
Those require the first real GitHub Actions runs and npm publication.

## Official references

- [Changesets automation](https://changesets.dev/guide/automating)
- [Changesets prereleases](https://changesets.dev/guide/prereleases)
- [Changesets tarball publishing](https://github.com/changesets/action/tree/v2/publish)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [Colima macOS integration workflow](https://github.com/abiosoft/colima/blob/main/.github/workflows/macos-integration.yml)
