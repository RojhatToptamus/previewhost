---
name: previewhost
description: Operate local previews and create or update PreviewSpec recipes with previewhost. Use for previewhost startup, inspection, troubleshooting, replacement, cleanup, or project configuration.
---

# previewhost

Use root `preview.yml` when present. If it is invalid, fix it before file-based startup.
If it is absent, construct a spec from project evidence and use it directly. A YAML file is optional.
Keep one preview name for continuing work and retained database data.
Read only the references needed for the current operation.

## Find the recipe and connection

Read project instructions and root `preview.yml`. An explicit alternate file or spec overrides that default.
Reuse the task's current sources, including uncommitted files and worktrees.
If no suitable recipe exists, use [Create or update a recipe](references/docs/recipes.md).

For CLI use, use `previewhost` from PATH or the project's `./node_modules/.bin/previewhost`.
Use `--help` to verify its syntax.
For MCP use, verify that the `preview_*` tools are available.
CLI and MCP automatically find or start one owner for the Git worktree root, or cwd outside Git.
Use `--project DIR` to select an explicit project. Configure MCP with that path when its launch cwd is uncertain.
On a cold start, trusted commands need `--allow-exec`; selected inputs and names use `--env` and `--secret`.
For example, register `previewhost mcp --project /absolute/project --allow-exec`.
An explicit `--endpoint` or `--token-file` selects connection-only mode for an existing manual daemon.
Never print token contents. Explicit connection mode cannot change owner launch permissions.

Use `list` or `preview_list` to check existing preview names. A missing owner is normal before first startup.
If installation or connection is missing, read the relevant [installation](references/README.md#install) or [MCP setup](references/docs/integrations.md#connect-an-mcp-client) section.
Automatic startup uses current launch arguments; it does not restore previous permissions from disk.
Do not restart or reconfigure a shared daemon to broaden access.
Commands require daemon execution permission. `--allow-exec` also permits managed database operations and explicit deletion/recovery.
An MCP denial remains a denial: do not switch to CLI or another daemon to bypass it.

## Operate the preview

For a person comparing or managing local applications, suggest `previewhost dashboard`.
It shows existing owners and supports diagnostics, Stop, Start again, and explicit create-only configuration saving.
Keep ordinary startup in the existing CLI/MCP workflow; do not open management automatically for every preview.

The CLI examples use optional root `preview.yml`, a preview named `app`, and the returned `ATTEMPT_ID`.
Substitute the actual recipe, name, executable, and connection arguments.
For direct MCP specs, use absolute `cwd` and `directory` paths, even when `project` is supplied.
Do not bind `PORT`, `HOST`, or `PREVIEW_URL` in `env`. Previewhost injects them at runtime.
CLI and MCP file paths inside recipes resolve relative to that file. MCP accepts `file` or `spec`, never both.
CLI accepts JSON stdin. Explicit file/stdin input overrides the root default.

| Operation | CLI | MCP |
| --- | --- | --- |
| Inspect the spec | `previewhost inspect` | `preview_inspect` |
| Start trusted commands | `previewhost start --allow-exec` | `preview_start` |
| Wait for an attempt | `previewhost wait app ATTEMPT_ID` | `preview_wait` |
| Read current status | `previewhost get app` | `preview_get` |
| Read bounded logs | `previewhost logs app ATTEMPT_ID --max-bytes 8192` | `preview_logs` |
| Replace | `previewhost replace` | `preview_replace` |
| Cancel a candidate | `previewhost cancel app ATTEMPT_ID` | `preview_cancel` |
| Stop the preview | `previewhost stop app` | `preview_stop` |

Inspection works offline before an owner exists. It validates the spec and sources, but does not install dependencies, verify health, or grant execution permission.
Prepare required dependencies through the project's existing commands before startup.
Verify command, platform, and service prerequisites that inspection cannot prove.
For native commands, use macOS, Node.js 22.23 or later, `ps`, and `lsof`.

CLI start/replace waits by default and can return `starting` after its wait budget. MCP start/replace returns before readiness.
Wait for the returned candidate ID and read the outcome's state and error.
A successful wait request can report a failed attempt.
Fetch the returned preview URL and verify the expected page or response.
For an interactive UI, also open it in an available browser.
Readiness alone does not prove that the application works.

A wait is limited to 30 seconds, independently of the recipe's readiness deadline.
A timeout, interrupted wait, or client disconnection leaves the preview running. There is no idle shutdown.
After an uncertain response, use get/list before another mutation.
Continue waiting for the same attempt, or cancel that exact pending candidate when cancellation is intended.
Canceling a replacement candidate preserves the active preview. Stop ends the whole named preview.

Use replacement for a continuing preview with the same name.
Replacement overlaps old and new processes. It cannot undo source edits or database migrations.
If preparation writes shared dependencies or build output, use the [worktree preparation rules](references/docs/worktrees.md#prepare-and-start).
If startup fails, read that attempt's logs and error before changing the recipe.

Stop the task's previews when cleanup is requested or their source will be removed.
Stop preserves source and owned database data. Attached servers and databases remain under their original owner.
Use CLI `shutdown` or MCP `preview_shutdown` only for requested owner teardown; it stops every preview on that owner.
Delete retained data only on an explicit request.
For incomplete cleanup or uncertain process ownership, use the [recovery guide](references/docs/troubleshooting.md#replacement-or-cleanup-is-incomplete).
Retain affected source until cleanup is complete.
Get/list include source directories on attempts and incomplete cleanup records. Check all consuming previews before source removal.

Save configuration only when the user requests it. MCP `preview_save_config` creates root `preview.yml` from the original prepared spec.
It validates source paths and declarative structure without resolving values, running code, or claiming application health.
Existing files are preserved. Use the host editor for requested updates, then validate the result.
Do not serialize inspection output: it omits literal environment bindings.

## Conditional references

- Recipe creation or changes: [decision guide](references/docs/recipes.md), then the relevant [spec fields](references/docs/api.md#specs).
- Framework arguments, allowed hosts, HMR, or origins: [framework configuration](references/docs/integrations.md#framework-configuration).
- Multiple services or databases: [frontend, backends, PostgreSQL, and Redis walkthrough](references/examples/multi-repo/README.md), then the relevant [environment bindings](references/docs/api.md#environment-specs).
- Existing task worktrees or shared preparation: [worktree guide](references/docs/worktrees.md).
- Missing stored credentials: [private secret entry](references/docs/api.md#stored-secrets).
  Use `preview_secrets_setup` / `preview_secrets_status`, or CLI `secrets setup` / `secrets status` with the selected connection.
  Let the owner approve unselected names and enter missing values in the private browser form. Never request values in chat or tool arguments, or inspect the form.
  For new bindings, choose a project-specific stored reference, such as `API_SECRET: {secret: "my-project/dev/api"}`.
  `API_SECRET` is the application variable; `my-project/dev/api` is the stored reference. Preserve existing references.
  Share an exact reference across projects or worktrees only when sharing is intended and approved.
  Approval lasts for this owner lifetime and permits any execution-authorized preview on it to bind the approved names.
  Wait on status with `timeoutMs: 25000`, retaining the request ID with its original project connection.
  Saving starts nothing. Re-read file-based specs, inspect current state, then retry normal start/replace after completion.
  If status is `canceled`, stop setup and wait for an explicit user request before new setup or startup.
  Do not interpret cancellation as accidental browser closure or ask for input in the canceled form.
  A wait timeout with `pending` or `saving` is not cancellation. Continue with the same request ID.
  `browser: "failed"` means launch failure; `expired` means the form expired. Ask before opening a new expired form.
  If the turn ends while setup is pending, the owner can finish the form and send “Secrets saved—continue”.
  A locked store requires owner unlock. Shutdown ends approvals but keeps stored values.
- Data retention, deletion, or exceptional recovery: [security and recovery](references/docs/security.md#recovery).

The reference examples are source material for recipes.
Use each example's documented setup. The multi-repository example requires a source checkout and its own dependencies.
Do not execute scripts from the skill's reference copy as though it were an installed package.
