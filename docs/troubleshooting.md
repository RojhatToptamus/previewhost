# Troubleshooting

Commands on this page use `previewd` from PATH.
For a local installation, use `./node_modules/.bin/previewd` from your application directory.
Replace `NAME`, `ATTEMPT_ID`, and `REQUEST_ID` with values from your configuration or command output.

## The client cannot find the daemon

Start `previewd serve` in a foreground terminal.
Use the same `--endpoint` and `--token-file` for each client.
`previewd mcp` does not start the daemon.

If the control port is occupied, start the daemon on another port:

```sh
previewd serve --root "$PWD" --port 9401
```

From a second terminal, connect to that endpoint:

```sh
previewd list --endpoint http://127.0.0.1:9401
```

previewd does not stop an existing port owner.
Separate daemons require separate private token and data directories.
One data directory permits only one runtime owner.

## Token permission errors

The token's parent directory must belong to your user and exclude group and other access.
Replace the path below with a new directory under an existing private parent:

```sh
mkdir -m 700 /path/owned/by/you/previewd-control
previewd serve --token-file /path/owned/by/you/previewd-control/token
```

The daemon creates the token. Keep its value out of project and MCP configuration files.
To connect, pass the same `--token-file` path to client commands.
After use, run `previewd shutdown --token-file /path/owned/by/you/previewd-control/token` from another terminal.

If a token is exposed, stop the daemon before you remove the token file.
The next daemon launch creates a new token.

## Codex reports `user cancelled MCP tool call`

This message alone does not prove that a person canceled the call.
Codex 0.146.0 `exec` canceled startup elicitation before dispatch with
`approval_policy="never"` and `approvals_reviewer="auto_review"`.

For the tested automatic-review path, use `on-request`, `auto_review`, and an enforceable sandbox.
Keep the relevant tool approval requirements enabled.
Check that review events and decisions occur.
See the [tested approval configurations](integrations.md#mcp-approvals).
The [Codex Desktop result](integrations.md#codex-desktop) has a separate UI access blocker.

For a reviewer denial, read the review rationale.
For a pending client approval, approve the specific operation through that client.
The daemon still requires separate permission for native execution.

## An MCP client waits for approval

Check the pending tool name and arguments before approval.
The tested clients used these per-request controls:

| Client | Control | Observed requirement |
| --- | --- | --- |
| Cursor IDE | **Run** or **Skip** | Both stop calls required approval |
| Claude Code | **Yes** | Each start and stop required approval |
| OpenCode | **Allow once** | Each start and stop required approval |

These prompts appeared before dispatch to previewd.
See [client versions and configurations](integrations.md) for the conditions.
Client approval does not grant the daemon's native execution permission.

## Startup fails or times out

1. Run `previewd get NAME`.
2. Read the attempt's output with `previewd logs NAME ATTEMPT_ID`.
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
To cancel the pending candidate, run `previewd cancel NAME ATTEMPT_ID`.
To stop the whole preview, run `previewd stop NAME`.

For environments, status includes `active.services`, `candidate.services`, or `latest.services`.
Each service reports its state and error. Logs include service prefixes.
A failed prerequisite can prevent dependent services from startup.

For a missing selected input, supply it to the daemon with `serve --env NAME`.
Only selected values reach `{fromEnv: NAME}` bindings.
previewd does not load `.env` files.
YAML files require one document without aliases, tags, or merge keys.

Managed databases require an explicit private `--data-dir` and cached local Docker images.
See the [database example](../examples/multi-repo/README.md).
External database URLs require `127.0.0.1`, an explicit port, and a valid database path.
A reachable TCP port does not prove successful authentication.

## Replacement or cleanup is incomplete

A candidate failure before cutover preserves the active route.
A cleanup failure after cutover leaves the new route active and reports the error.
Replacement does not roll back after cutover.

Read the error before another `previewd stop NAME` attempt.
If the error identifies a process group, inspect its members:

```sh
ps -axo pid,ppid,pgid,lstart,command
```

Compare the reported group and process details with your application.
A port, process name, or directory alone does not establish ownership.
If ownership is uncertain, leave the processes intact until you identify their owner.

Stop can complete after the owned processes exit.
A daemon restart loses native cleanup handles and cannot repair an unknown group.

## Stored secrets are missing or inaccessible

For `SECRET_REQUIRED`, run `previewd secrets setup --file preview.yaml` or call `preview_secrets_setup` through MCP.
Enter values only in the private owner form.
Save does not start an application.
Check `previewd secrets status REQUEST_ID` before a startup retry.

If the browser cannot open, use `previewd secrets set ID` in a terminal.
Then request setup again. `setup --reopen` reopens a pending form.

`--stdin` accepts a pipe. Hidden terminal entry is the default.
Keep values out of arguments.
A page refresh or close loses its grant from browser memory.

For `SECRET_DENIED`, check the daemon's exact `--secret ID` selections and authorization.
`--allow-exec` alone does not select stored secrets.

For locked storage, unlock the default Keychain in Keychain Access.
For access errors, check the packaged helper's permission for the item.
An updated helper can require approval. Do not grant all applications access.
A missing helper requires a macOS package build.

Partial saves retain completed writes.
An unknown write result can already have changed the item.
Check public status before a fresh setup request for remaining entries.
Presence alone does not prove that an explicit edit succeeded.

## Database data or recovery is incomplete

Stop preserves data. Retained names and cleanup errors appear in `get` and `list`,
including after a daemon restart.
`previewd delete-data NAME` permanently removes a stopped environment's owned data after authorization.

If deletion reports active applications, stop the environment first.
If Docker cleanup is incomplete, resolve its error before data deletion.
For `data.cleanup.operation: "remove-credential"`, Docker data is already gone.
Unlock Keychain and retry `previewd delete-data NAME` directly.
Stop and daemon shutdown remain available while credential deletion is pending.

If another runtime owns the data directory, use that owner or stop it normally.
Keep the lock inode intact while any runtime can use it.

An uncertain Docker creation can remain pending despite an empty object lookup.
A late Engine operation can still create that object.
After an operator restarts the actual local Docker Engine, request recovery:

```sh
previewd stop NAME --after-engine-restart
previewd get NAME
```

The flag asserts that the Engine restart occurred. It does not restart Docker.
A previewd restart alone does not meet this prerequisite.
A changed Engine or conflicting object identity still prevents cleanup.
Broad Docker prune or manual record deletion bypasses ownership checks and cannot repair this uncertainty.

A missing retained credential requires restoration from its Keychain backup.
previewd does not regenerate a password for existing data.
Migration conflicts preserve schema 1 records and existing database authentication.
Keep the record intact during repair of the copied item in Keychain Access.
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

If the client lacks Node on PATH, use an absolute Node executable as its command.
Pass the installed `previewd/dist/cli.js` path and `mcp` as arguments.
Run `node -p process.execPath` in your shell to find Node.

Start the foreground daemon separately.
MCP stdout must contain only protocol messages.
Remove shell wrappers that print banners to stdout.
Check the tool list for twelve `preview_*` tools, including secret setup/status.
Read the tool's error envelope before a retry.
See [MCP client configuration](integrations.md#connect-an-mcp-client).
