---
name: previewhost
description: Operate local previews and create or update PreviewSpec recipes with previewhost. Use for previewhost startup, inspection, troubleshooting, replacement, cleanup, or project configuration.
---

# previewhost

Use the project's existing recipe and the CLI or MCP connection available to the task.
Keep one preview name for continuing work and retained database data.
Read only the references needed for the current operation.

## Find the recipe and connection

Read project instructions and search scripts, JSON/YAML files, and project documentation for an existing previewhost recipe.
Reuse the task's current sources, including uncommitted files and worktrees.
If no suitable recipe exists, use [Create or update a recipe](references/docs/recipes.md).

For CLI use, use `previewhost` from PATH or the project's `./node_modules/.bin/previewhost`.
Use `--help` to verify its syntax.
For MCP use, verify that the `preview_*` tools are available.
Both interfaces require a separately running daemon.
Use the owner's endpoint and token-file path. Never print the token contents.
Append `--endpoint` and `--token-file` to CLI client commands when their defaults differ.

Use `list` or `preview_list` to verify connectivity and existing preview names.
If installation or connection is missing, read the relevant [installation](references/README.md#install) or [MCP setup](references/docs/integrations.md#connect-an-mcp-client) section.
Start a dedicated daemon only within the task's authorization, with the required source roots and permissions.
Do not restart or reconfigure a shared daemon to broaden access.
Commands require daemon execution permission. `--allow-exec` also permits managed database operations and explicit deletion/recovery.
An MCP denial remains a denial: do not switch to CLI or another daemon to bypass it.

## Operate the preview

The CLI examples use `preview.yaml`, a preview named `app`, and the returned `ATTEMPT_ID`.
Substitute the actual recipe, name, executable, and connection arguments.
For MCP, use its declared tool schema and absolute source paths.
CLI file paths inside recipes resolve relative to the recipe file.

| Operation | CLI | MCP |
| --- | --- | --- |
| Inspect the recipe | `previewhost inspect --file preview.yaml` | `preview_inspect` |
| Start | `previewhost start --file preview.yaml` | `preview_start` |
| Wait for an attempt | `previewhost wait app ATTEMPT_ID` | `preview_wait` |
| Read current status | `previewhost get app` | `preview_get` |
| Read bounded logs | `previewhost logs app ATTEMPT_ID --max-bytes 8192` | `preview_logs` |
| Replace | `previewhost replace --file preview.yaml` | `preview_replace` |
| Cancel a candidate | `previewhost cancel app ATTEMPT_ID` | `preview_cancel` |
| Stop the preview | `previewhost stop app` | `preview_stop` |

Inspect before startup. Inspection validates the spec and sources, but does not install dependencies, verify health, or grant execution permission.
Prepare required dependencies through the project's existing commands before startup.
Verify command, platform, and service prerequisites that inspection cannot prove.
For native commands, use macOS, Node.js 22.23 or later, `ps`, and `lsof`.

CLI start/replace waits by default. MCP start/replace returns before readiness.
Wait for the returned candidate ID and read the outcome's state and error.
A successful wait request can report a failed attempt.
Fetch the returned preview URL and verify the expected page or response.
For an interactive UI, also open it in an available browser.
Readiness alone does not prove that the application works.

A wait is limited to 30 seconds, independently of the recipe's readiness deadline.
A timeout, interrupted wait, or client disconnection leaves the preview running.
After an uncertain response, use get/list before another mutation.
Continue waiting for the same attempt, or cancel that exact pending candidate when cancellation is intended.
Canceling a replacement candidate preserves the active preview. Stop ends the whole named preview.

Use replacement for a continuing preview with the same name.
Replacement overlaps old and new processes. It cannot undo source edits or database migrations.
If preparation writes shared dependencies or build output, use the [worktree preparation rules](references/docs/worktrees.md#prepare-and-start).
If startup fails, read that attempt's logs and error before changing the recipe.

Stop the task's previews when cleanup is requested or their source will be removed.
Stop preserves source and owned database data. Attached servers and databases remain under their original owner.
Shut down a daemon only if this task owns it and no other work uses it.
Delete retained data only on an explicit request.
For incomplete cleanup or uncertain process ownership, use the [recovery guide](references/docs/troubleshooting.md#replacement-or-cleanup-is-incomplete).
Retain affected source until cleanup is complete.

## Conditional references

- Recipe creation or changes: [decision guide](references/docs/recipes.md), then the relevant [spec fields](references/docs/api.md#specs).
- Framework arguments, allowed hosts, HMR, or origins: [framework configuration](references/docs/integrations.md#framework-configuration).
- Multiple services or databases: [frontend, backends, PostgreSQL, and Redis walkthrough](references/examples/multi-repo/README.md), then the relevant [environment bindings](references/docs/api.md#environment-specs).
- Existing task worktrees or shared preparation: [worktree guide](references/docs/worktrees.md).
- Missing stored credentials: [private secret entry](references/docs/api.md#stored-secrets).
  Use `preview_secrets_setup` / `preview_secrets_status`, or CLI `secrets setup` / `secrets status` with the selected connection.
  Let the owner enter values in the private browser form. Never request values in chat or tool arguments.
  Saving starts nothing. Retry normal start/replace after setup completes.
  A denied selection or locked store requires the owner's action, not an alternate interface.
- Data retention, deletion, or exceptional recovery: [security and recovery](references/docs/security.md#recovery).

The reference examples are source material for recipes.
Use each example's documented setup. The multi-repository example requires a source checkout and its own dependencies.
Do not execute scripts from the skill's reference copy as though it were an installed package.
