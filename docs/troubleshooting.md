# Troubleshooting

## The client cannot find the daemon

Start `previewd serve` in a foreground terminal. Use the same `--endpoint` and
`--token-file` for each client. The daemon does not start from `previewd mcp`.
Port conflicts fail explicitly. previewd never stops the existing port owner.

If the default port is occupied, use another port:

```sh
previewd serve --root "$PWD" --port 9401
previewd list --endpoint http://127.0.0.1:9401
```

For separate daemon instances, use separate private token directories too.

## Token permission errors

Use a token directory owned only by your user. Do not use `/tmp/token` directly.
The containing directory must exclude group and other access.

```sh
mkdir -m 700 /path/owned/by/you/previewd-control
previewd serve --token-file /path/owned/by/you/previewd-control/token
```

The daemon creates the token. Do not put its value in project files or MCP
configuration. If a token is exposed, stop the daemon before removing that token
file. The next daemon launch creates a new token.

## Startup fails or times out

Read `previewd get NAME`, then `previewd logs NAME ATTEMPT_ID`.
Verify the command working directory, installed dependencies, port arguments,
and readiness path. The readiness endpoint must return HTTP 200–399 headers.

Native commands must bind to `127.0.0.1` and use the allocated port. Use `{port}`
in argv when the framework does not read `PORT`. Automatic fallback to another
port fails ownership verification. Disable framework port fallback.

If execution is denied, review the command before restarting the owner with
`--allow-exec`. A client cannot grant this permission.
If the platform is unsupported, serve static output or attach to an independently
owned server on a verified platform. Native command support currently requires macOS.

A CLI wait timeout does not cancel startup. Read status before another start.
Use `previewd cancel NAME ATTEMPT_ID` to cancel the exact candidate.
Use `previewd stop NAME` to stop the whole preview.

## Replacement or cleanup is incomplete

A failed candidate keeps the active route. If cleanup fails after cutover, the
new route remains active. The status identifies the retained cleanup error.
Do not assume that replacement rolled back.

Read the reported error before retrying `previewd stop NAME`. If the error
identifies a process group, inspect its members with an operating-system tool:

```sh
ps -axo pid,ppid,pgid,lstart,command
```

Compare the reported group and process details with your application. Do not
kill by port, process name, or directory alone. If ownership is uncertain,
leave those processes untouched until you identify their owner.

Stop can complete after the verified processes exit. Restart discards runtime
observations and cannot repair an unknown process group.

## The browser shows old content or HMR disconnects

Use the URL from the latest status. A stopped and restarted preview can have a
new port. Replacement keeps the URL but closes old streams after one second.

Verify that the application uses its public preview origin for absolute URLs
and WebSocket connections. `PREVIEW_URL` supplies that origin to native commands.
See the [framework configurations](integrations.md).

For a live source directory, filesystem edits affect the running server directly.
Replacement does not restore earlier source files.

## An attempt no longer exists

`ATTEMPT_EXPIRED` means that the ID is unknown or outside retained history.
Call `get` or `list` for current observations. A newer replacement does not keep
every previous attempt or log tail.

## MCP has no tools or reports connection errors

Use an absolute executable path when the client does not inherit your shell PATH.
Start the foreground daemon separately. MCP stdout must contain protocol messages
only. Remove shell wrappers that print banners to stdout.

Check the client tool list for nine `preview_*` tools. Inspect the tool error
envelope before retrying. Host configuration examples and verified client versions
appear in [integrations](integrations.md).
