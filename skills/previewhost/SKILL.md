---
name: previewhost
description: Operate local previews and create or update PreviewSpec recipes with previewhost. Use for previewhost startup, inspection, troubleshooting, replacement, cleanup, or project configuration.
---

# previewhost

Use root `preview.yaml`, then `preview.yml` if it is absent. If both exist, report the conflict.
If the selected file is invalid, fix it before file-based startup.
If neither file exists, construct a spec from project evidence and use it directly. A YAML file is optional.
Keep one preview name for continuing work and retained database data.
Read only the references needed for the current operation.

## Find the recipe and connection

Read project instructions and the selected root configuration. An explicit file or spec bypasses default lookup, including filename conflicts.
Reuse the task's current sources, including uncommitted files and worktrees.
If no suitable recipe exists, use [Create or update a recipe](references/docs/recipes.md).

For CLI use, use `previewhost` from PATH or the project's `./node_modules/.bin/previewhost`.
Use `--help` to verify its syntax.
For MCP use, verify that the `preview_*` tools are available.
CLI automatically finds or starts one owner for the Git worktree root, or cwd outside Git.
Use CLI `--project DIR` to select an explicit project.
For MCP, supply this chat's absolute worktree path as `project` on every tool call.
Keep that project with its attempt and secret-request IDs. A shared MCP connection does not identify the current chat.
Use one global registration: `previewhost mcp --allow-exec`.
Before using an unapproved project, call `preview_access` with the actual project and any required backend source directories.
The client asks the user to approve those directories. A path in tool arguments is not permission.
After denial or cancellation, stop until the user explicitly asks to resume. Never change registration or relocate source to bypass denial.
Reconnection needs new project approval; existing owners and their private-secret approvals keep running.
Explicit `--root` or `--project` registrations retain their restrictions; `preview_access` is unavailable in those modes.
Identify required APIs, database connections and migrations from application code and documentation.
Declare finite migrations and seeds as `type: job` with `dependsOn`; see [setup jobs](references/docs/jobs.md).
Use repeatable migrations with `run: always` and `run: once` for seeds that must not repeat with retained managed data.
After a failed or interrupted once job, inspect partial writes and wait for an explicit user request before `preview_rerun_job` or data deletion.
A zero exit code cannot reveal swallowed script errors. Prefer an API readiness route that queries required tables, not `/openapi.json`.
A frontend-only preview is incomplete when the application needs a backend. Ask for missing dependency locations only when evidence is insufficient.
On a cold start, trusted commands need `--allow-exec`; selected inputs and names use `--env` and `--secret`.
An explicit `--endpoint` or `--token-file` selects connection-only mode for an existing manual daemon.
Never print token contents. In explicit connection mode, omit the MCP `project` argument.
That connection cannot change owner launch permissions.

Use `list` or `preview_list` to check existing preview names. A missing owner is normal before first startup.
If installation or connection is missing, read the relevant [installation](references/docs/installation.md) or [MCP setup](references/docs/mcp.md) guide.
Automatic startup uses current launch arguments; it does not restore previous permissions from disk.
Do not restart or reconfigure a shared daemon to broaden access.
Commands require daemon execution permission. `--allow-exec` also permits managed database operations and explicit deletion/recovery.
An MCP denial remains a denial: do not switch to CLI or another daemon to bypass it.

## Operate the preview

For a person comparing or managing local applications, suggest `previewhost dashboard`.
It lists automatic project owners and retained data, including offline entries.
Use its preview menus for stop, start, reset, data deletion, and entry removal. Configuration saving remains explicit and create-only.
Start preview reuses the retained configuration and current source without reloading YAML.
The dashboard does not start owners or replace the private secret form.
Keep ordinary startup in the existing CLI/MCP workflow; do not open management automatically for every preview.

The CLI examples use optional root `preview.yaml`, a preview named `app`, and the returned `ATTEMPT_ID`.
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
Native commands require Node.js 22.23 or later on macOS, Linux, or Windows.
Linux also requires procps (`/bin/ps`) and `lsof` (`/usr/bin/lsof`).

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
Use CLI `shutdown` or MCP `preview_shutdown` only for requested owner teardown; it stops every preview on that owner, ends dynamic secret approvals, and leaves other project owners unaffected.
Delete retained data only on an explicit request.
For incomplete cleanup or uncertain process ownership, use the [recovery guide](references/docs/troubleshooting.md#replacement-or-cleanup-is-incomplete).
Retain affected source until cleanup is complete.
Get/list include source directories on attempts and incomplete cleanup records. Check all consuming previews before source removal.

Save configuration only when the user requests it. MCP `preview_save_config` creates root `preview.yaml` from the original prepared spec.
Saving fails if either default filename exists, including a directory or symlink.
It validates source paths and declarative structure without resolving values, running code, or claiming application health.
Existing files are preserved. Use the host editor for requested updates, then validate the result.
Do not serialize inspection output: it omits literal environment bindings.

## Conditional references

- Recipe creation or changes: [decision guide](references/docs/recipes.md), then the relevant [spec fields](references/docs/api.md#specs).
- Framework arguments, allowed hosts, HMR, or origins: [framework configuration](references/docs/integrations.md#framework-configuration).
- Multiple services or databases: [frontend, backends, PostgreSQL, and Redis walkthrough](references/examples/multi-repo/README.md), then the relevant [environment bindings](references/docs/api.md#environment-specs).
- Existing task worktrees or shared preparation: [worktree guide](references/docs/worktrees.md).
- Stored credentials or managed database unlock: [private secret entry](references/docs/api.md#stored-secrets).
  Use `preview_secrets_setup` / `preview_secrets_status`, or CLI `secrets setup` / `secrets status` with the selected connection.
  Use private secret bindings for required credential variables, including dummy local API keys. Never invent credential literals.
  Let the owner approve unselected names, create or unlock the keystore, and enter missing values in the private browser form.
  Never request passwords or secret values in chat or tool arguments. Never inspect the private form.
  Managed databases also require an unlocked keystore, even without user-secret references.
  Dashboard unlock applies only to the dashboard. Each project owner unlocks separately unless automatic unlock is available on macOS.
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
  A locked store requires private owner unlock. Shutdown ends approvals and that unlocked session, but keeps stored values.
  Do not read or migrate old Keychain entries. For unsupported retained records, follow the documented reset procedure without deleting old data.
- Data retention, deletion, or exceptional recovery: [security and recovery](references/docs/security.md#recovery).

The reference examples are source material for recipes.
Use each example's documented setup. The multi-repository example requires a source checkout and its own dependencies.
Do not execute scripts from the skill's reference copy as though it were an installed package.
