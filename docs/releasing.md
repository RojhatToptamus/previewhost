# Releases

previewhost uses Changesets 3 and GitHub Actions, starting at `0.1.0-alpha.0`.
`.changeset/pre.json` selects the `alpha` prerelease channel.
Only a maintainer's explicit promotion leaves that channel.

## Make a release

1. Implement and verify the change on a branch.
2. Run `npm run changeset`. Select `previewhost`, choose the version change,
   and describe the user-visible result. Include that changeset in the PR.
3. Merge the PR into `main`. The Release workflow creates or updates
   `changeset-release/main`, with the version, lockfile, and changelog changes.
4. On that release PR, select **Approve workflows to run** when GitHub requests it.
   Review the changelog and wait for **Verify macOS package** to pass.
5. Merge the release PR. Release verifies the merged source, publishes the
   verified tarball to npm, and creates a GitHub prerelease with changelog notes.

Use patch for fixes, minor for features, and major for breaking changes.
Prerelease numbering follows Changesets. A new patch changeset after the initial
alpha produces `0.1.0-alpha.1`. Alpha releases use `npm install previewhost@alpha`.
Do not change the package version or npm tag by hand for normal releases.

Documentation and tooling changes that do not affect the package need no changeset.
The initial alpha has already been versioned; its consumed changeset is under
`.changeset/pre/`. Changesets retains these entries for the eventual regular changelog.

## What runs

`.github/workflows/ci.yml` runs for PRs targeting `main`. Release also calls it
before publication. It installs dependencies, starts local Docker through Colima,
pulls the two database fixture images, and runs `npm run verify:release`.
That existing gate requires macOS, an explicit local Unix socket, and zero skipped,
failed, canceled, or TODO tests. It does not accept a partial test run.

The runner is `macos-15-intel`, which Colima uses in its own integration workflow.
Native compilation requires Xcode Command Line Tools. The build produces one
ad-hoc signed Keychain helper with `arm64` and `x86_64` slices. Consumers do not
compile it during installation. CI uses Node.js 24; the package minimum remains
Node.js 22.23. Local arm64 results do not establish hosted Intel compatibility.

For a release, Changesets packs the completed build with lifecycle scripts disabled.
CI downloads that uploaded artifact and checks its release version and dist-tag.
`npm run check:package` installs that exact tarball outside the repository. It checks
its inventory, both native architectures, code signature, executable permissions,
ESM imports, CLI startup, MCP discovery and version, cleanup, and TypeScript declarations.
Only after this succeeds can the publish job consume the same artifact by ID.
The publisher runs on hosted Ubuntu and does not rebuild or repack the source.

The publish job alone receives `id-token: write`. It uses npm 11 for Trusted
Publishing and `contents: write` for tags and GitHub releases. The prepare job uses
`contents: write` and `pull-requests: write` for release PRs. Verification gets only
`contents: read`. Release runs are serialized and are not canceled during publication.

The npm allowlist includes compiled JavaScript and declarations, the native helper,
four files used by README examples, README, LICENSE, NOTICE, and package metadata.
It excludes `docs/`, CONTRIBUTING, changelogs, changesets, workflows, source,
tests, fixtures, and local data. Repository documentation remains on GitHub.
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
PREVIEWD_TEST_DOCKER_SOCKET="$HOME/.docker/run/docker.sock" npm run verify:release
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

Confirm that `alpha` points to `0.1.0-alpha.0`. Changesets documents a first-publish
`latest` exception. Its current CLI also chooses `latest` if every published
version is an alpha and the registry has a `latest` tag. Our release check rejects
that plan, so an alpha cannot silently move to `latest`.
If npm adds `latest` to this first alpha, remove it with
`npm dist-tag rm previewhost latest` and verify the tags again. If the registry
refuses removal, stop and resolve that restriction before automated alpha releases.
Use `npm view previewhost@alpha dist-tags --json` after removal; an unqualified
lookup can return no output when `latest` is absent.
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

The repository is currently private. npm supports Trusted Publishing for private
repositories, but automatic provenance is unavailable. If the repository becomes
public, npm generates provenance automatically for OIDC publications.
Changing repository visibility is a separate decision.

## Promote to a regular release

On a branch, run:

```sh
npm run changeset -- pre exit
```

Review the retained `.changeset/pre/` notes and include the exit change in a PR.
After it merges, Changesets opens a regular release PR. Review its version and
changelog, approve its CI if requested, and merge it to publish to `latest`.
For the current initial alpha series, the regular version is `0.1.0`.
The release workflow derives the expected tag from the version, so no workflow
edit is needed. Existing `alpha` tags remain until deliberately changed.

## Failures and verification limits

A failing test, native check, inventory check, or tag check blocks publication.
For a test/build failure, fix the cause and rerun Release on `main`.
Do not bypass the zero-skip release gate.

If publication or GitHub release creation fails, first inspect
`npm view previewhost@alpha versions dist-tags --json` and the GitHub release.
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
