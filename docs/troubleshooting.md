# Troubleshooting

Resolve Previewhost installation, startup, routing, database, and secret access errors. Recover an owner or inspect a failed preview.

Commands on this page use `previewhost` from PATH.
For a local installation, use `./node_modules/.bin/previewhost` from your application directory.
Replace `NAME`, `ATTEMPT_ID`, and `REQUEST_ID` with values from your configuration or command output.

## The client cannot find previewhost

An MCP client can use a different PATH from your terminal.
From a terminal where previewhost works, find its executable:

```sh
command -v previewhost
```

Use the returned absolute path as the MCP `command`. Retain the startup options in `args`.
For example:

```json
{
  "mcpServers": {
    "previewhost": {
      "command": "/absolute/npm-prefix/bin/previewhost",
      "args": ["mcp", "--allow-exec"]
    }
  }
}
```

Replace the example path with the command output.
The executable also needs `node` on the client's PATH.
If Node is missing, add its directory to the client's PATH and restart the client.
The daemon's PATH must also resolve any application commands.

For clients that require an absolute Node command, find Node and the global package directory:

```sh
node -p process.execPath
npm root -g
```

Use the Node path as `command`.
Set `args` to `["/absolute/global/node_modules/previewhost/dist/cli.js", "mcp", "--allow-exec"]`.
Replace `/absolute/global/node_modules` with the directory from `npm root -g`.
For a local package, use its absolute `node_modules/previewhost/dist/cli.js` path instead.

## The client cannot find the daemon

Without an explicit connection, CLI uses the canonical project root. MCP uses the tool call's `project` or registration's `--project` default.
Check that the selected path is this chat's actual worktree.
Read/status/cleanup operations never start a missing owner. Inspect works offline.

Start or secret setup can create the owner with the required current launch flags, such as `--allow-exec`.
An owner with incompatible configuration stays unchanged. To apply new options, explicitly shut down only that project:

```sh
previewhost shutdown --project /absolute/project
```

Use its actual path and omit launch overrides such as `--root`.
Shutdown stops that owner's previews and ends dynamic secret approvals. Stored values and managed data remain.
Other project owners are unaffected. Restart with the corrected registration. If private setup requests secret access again, approve the intended references.

For `SOURCE_DENIED` with global registration, ask the agent to call `preview_access` for its actual project and dependency directories.
For explicitly restricted registrations, use a matching `--root` for the repository itself, not its parent folder.
That restriction includes its registered Git worktrees.
Do not copy sources into another directory or substitute another project to bypass the denial.

After a crash, `CLEANUP_INCOMPLETE` names the retained connection file.
Retain sources and check old application/process-group cleanup, using the existing recovery checks below.
The record's PID is a diagnostic clue, not authority to kill a process. An absent owner does not prove its children stopped.

Only after cleanup is confirmed, remove that project's `connection.json` and retry. Keep the permanent `.lock` inode.
Before removing a crash record, note its data directory and Docker socket. Reuse those
settings on restart, especially with a custom data location.
Clean shutdown keeps an offline record while managed data remains. The dashboard and
`previewhost projects` still list it. Use **Delete data** to erase its managed databases,
then **Remove entry** to clear the empty record. Source files need not still exist.
Saved user secrets are unaffected. For unavailable entries, use **Recheck status** to retry
the connection. **Remove entry** checks the recorded process, locks, and retained data.
If those checks pass, confirm that application processes have stopped before removing it.
An unreachable owner alone is not evidence of cleanup. Missing data-location metadata,
live processes, or retained data block removal; the review shows the reason.

For an explicit manual connection, start `previewhost serve` in a foreground terminal.
Use the same `--endpoint` and `--token-file` for its clients. Explicit connection mode never starts or reconfigures an owner.

If the control port is occupied, start the daemon on another port:

```sh
previewhost serve --root "$PWD" --port 9401
```

From a second terminal, connect to that endpoint:

```sh
previewhost list --endpoint http://127.0.0.1:9401
```

previewhost does not stop an existing port owner.
Separate daemons require separate private token and data directories.
One data directory permits only one runtime owner.

## Token permission errors

The token's parent directory must belong to your user and exclude group and other access.
Replace the path below with a new directory under an existing private parent:

```sh
mkdir -m 700 /path/owned/by/you/previewhost-control
previewhost serve --token-file /path/owned/by/you/previewhost-control/token
```

The daemon creates the token. Keep its value out of project and MCP configuration files.
To connect, pass the same `--token-file` path to client commands.
After use, run `previewhost shutdown --token-file /path/owned/by/you/previewhost-control/token` from another terminal.

If a token is exposed, stop the daemon before you remove the token file.
The next daemon launch creates a new token.

## Codex reports `user cancelled MCP tool call`

This message alone does not prove that a person canceled the call.
Codex 0.146.0 `exec` canceled startup elicitation before dispatch with
`approval_policy="never"` and `approvals_reviewer="auto_review"`.

Check the client's approval policy and the reason for cancellation.
[Recorded client checks](integrations.md#tested-clients) apply only to their listed versions and modes.

For a reviewer denial, read the review rationale.
For a pending client approval, approve the specific operation through that client.
The daemon still requires separate permission for native execution.

## An MCP client waits for approval

Check the pending tool name and arguments in your client.
If you want the operation to proceed, approve that request there.
The call cannot reach Previewhost until client approval completes.
Client approval does not grant execution permission to the project owner or select stored secrets.
See [MCP setup](mcp.md).

## Startup fails or times out

1. Run `previewhost get NAME`.
2. Read the attempt's output with `previewhost logs NAME ATTEMPT_ID`.
3. Check the working directory, dependencies, port arguments, and readiness path.

The readiness endpoint must return HTTP 200–399 headers.
Native commands must bind to `127.0.0.1` and use the allocated port.
If the framework does not read `PORT`, use `{port}` in its arguments.
Disable automatic port fallback. A different port fails the ownership check.

For `EXECUTION_DENIED`, review the command before a daemon restart with `--allow-exec`.
This permission also permits managed databases and explicit data deletion/recovery.
A client cannot grant it. Native command support requires macOS.

A CLI wait timeout leaves startup active.
Read status before another start.
To cancel the pending candidate, run `previewhost cancel NAME ATTEMPT_ID`.
To stop the whole preview, run `previewhost stop NAME`.

For environments, status includes `active.services`, `candidate.services`, or `latest.services`.
Each service reports its state and error. Logs include service prefixes.
If a dependency fails to start, services that need it cannot start.

For a missing selected input, select its current value at owner startup with `--env NAME`.
Only selected values reach `{fromEnv: NAME}` bindings.
previewhost does not load `.env` files.
YAML files require one document without aliases, tags, or merge keys.

Managed databases require private data storage and cached local Docker images.
Automatic owners default to separate private storage per project. Foreground `serve` requires `--data-dir`.

If an existing automatic owner reports missing `dataDirectory`, upgrade Previewhost and explicitly shut down that project owner before retrying.
Restarting the MCP client alone does not restart its owner. See [owner restart instructions](#the-client-cannot-find-the-daemon).
See the [database example](../examples/multi-repo/README.md).

External database URLs require `127.0.0.1`, an explicit port, and a valid database path.
A reachable TCP port does not prove successful authentication.

## Replacement or cleanup is incomplete

If the new application fails before requests switch to it, the old application remains available.
If cleanup of the old application fails after the switch, the new application remains active.
Status reports the cleanup error.

Read the error before another `previewhost stop NAME` attempt.
If the error identifies a process group, inspect its members:

```sh
ps -axo pid,ppid,pgid,lstart,command
```

Compare the reported group and process details with your application.
A port, process name, or directory alone does not establish ownership.
If ownership is uncertain, leave the processes intact until you identify their owner.

Stop can complete after the owned processes exit.
A daemon restart loses the process records needed for cleanup. It cannot identify an unknown group's owner.

## Stored secrets are missing or inaccessible

For `SECRET_REQUIRED` or unselected references, follow [private secret setup](secrets.md#approve-and-enter-values).
The private owner form first approves access to unselected names, then collects missing values. Existing values are reused.
Save does not start an application.

Check `previewhost secrets status REQUEST_ID --timeout-ms 25000` before a startup retry.
Use the original project path and re-read the current spec. If the agent turn ended, send “Secrets saved. Continue.”

If status is `canceled`, stop setup. Wait for an explicit user request before new setup or startup.
Do not assume the user closed the browser accidentally. A canceled form cannot be reused.

A wait timeout with `pending` or `saving` leaves setup in progress. Use the same request ID.
If status is `expired`, ask before requesting a new form.

If the browser cannot open, `browser: "failed"` reports launch failure. `setup --reopen` retries a pending form.

For already selected names, use `previewhost secrets set ID` in a terminal, then request setup again.
Terminal entry stores a value but does not approve runtime access. Unselected names still need private approval or explicit owner startup with `--secret ID`.

`--stdin` accepts a pipe. Hidden terminal entry is the default.
Keep values out of arguments.
Refreshing or closing the private secret form loses its grant from browser memory.
The dashboard is separate: its session can survive a same-tab reload.

For `SECRET_DENIED`, request private setup for the exact current references, or check the owner's explicit `--secret ID` launch selections.
Do not bypass owner denial through another interface.
`--allow-exec` alone does not select stored secrets.

For a locked keystore, enter its password in private setup. Wrong passwords leave the form available for retry.
The dashboard unlocks only its own session. Each owner needs private setup or a remembered macOS unlock key.
If automatic unlock fails, use your password. Keychain Access can repair the helper's item permission on macOS.
An updated helper can require renewed permission. Never grant all applications access.
A failed “Remember” leaves the current session unlocked and shows a warning.
“Forget” affects new sessions, not existing owners. Shut down an owner to end its session and approvals.
For old installations, follow the [reset instructions](../README.md#reset-required-for-earlier-installations).

Partial saves retain completed writes.
`partial` is terminal. Its private form cannot accept another submission.
After resolving the reported error, request fresh setup instead of waiting on the old result.

An unknown write result can already have changed the item.
Check public status before a fresh setup request for remaining entries.
Presence alone does not prove that an explicit edit succeeded.

## Database data or recovery is incomplete

Stop preserves data. Retained names and cleanup errors appear in `get` and `list`,
including after a daemon restart.
`previewhost delete-data NAME` permanently removes a stopped environment's owned data after authorization.

If deletion reports active applications, stop the environment first.
If Docker cleanup is incomplete, resolve its error before data deletion.
For `data.cleanup.operation: "remove-credential"`, Docker data is already gone.
Unlock the owner through private setup and retry `previewhost delete-data NAME` directly.
Stop and daemon shutdown remain available while credential deletion is pending.

If another runtime owns the data directory, use that owner or stop it normally.
Keep the lock inode intact while any runtime can use it.

An uncertain Docker creation can remain pending despite an empty object lookup.
A late Engine operation can still create that object.
After an operator restarts the actual local Docker Engine, request recovery:

```sh
previewhost stop NAME --after-engine-restart
previewhost get NAME
```

Use this flag only after the Engine restart finishes. The flag does not restart Docker.
A previewhost restart alone does not meet this prerequisite.
A changed Engine or conflicting object identity still prevents cleanup.
Broad Docker prune or manual record deletion bypasses ownership checks and cannot repair this uncertainty.

A missing retained credential requires restoration of a complete encrypted keystore backup.
Previewhost does not regenerate a password for existing data.
Unsupported old records remain intact. Use the earlier release to export valuable data before an explicit reset.
See [credentials and backups](security.md#credentials-and-backups).

## The browser shows old content or HMR disconnects

Use the URL from current status.
Stop/start can change the port. Replacement keeps the URL and closes old streams
after one second. It does not restore earlier source files.

Check the application's public origin for absolute URLs and WebSocket connections.
`PREVIEW_URL` supplies that origin to native commands.
See [framework configuration](integrations.md#framework-configuration).

An environment's numeric URL reaches its primary service.
Other HTTP services use browser aliases on the same port.
Native DNS clients do not necessarily resolve those aliases.
Use `{service: NAME}` for native dependencies and `{browserUrl: NAME}` for browser requests.
Public references add no readiness dependency and can reach the active application during replacement.

## An attempt no longer exists

`ATTEMPT_EXPIRED` means the ID is unknown or outside retained history.
Call `get` or `list` for current status.
The runtime does not retain every previous attempt or log tail.

## MCP has no tools or reports connection errors

For executable lookup errors, use the [PATH troubleshooting steps](#the-client-cannot-find-previewhost).

Check the project context and current launch authority. Only explicit endpoint/token mode needs a separately running daemon.

MCP stdout must contain only protocol messages.
Remove shell wrappers that print banners to stdout.
Check for `preview_start`, `preview_secrets_setup`, `preview_save_config`, and `preview_rerun_job`. Global mode also exposes `preview_access`.

Read the tool's error envelope before a retry.
After changing a registration's command or environment, reload the client workspace and reconnect the server.

In Cursor 3.20.7, an edited registration showed connected tools while agent calls timed out. A new server name after reload restored calls.
Check an actual tool result after reconnection. See the [recorded client check](integrations.md#cursor-ide).
See [MCP client configuration](integrations.md#connect-an-mcp-client).
