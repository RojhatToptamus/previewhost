# API and CLI reference

## Runtime and client

The ESM package exports `createPreviewRuntime`, `connectPreviewDaemon`,
`PreviewError`, and public TypeScript types. Both interfaces implement `PreviewApi`.

```ts
const runtime = await createPreviewRuntime({
  allowedRoots: ['/absolute/project'],
  authorize: async ({ operation, spec, signal }) => {
    return hostApproval({ operation, spec, signal });
  },
});

const client = connectPreviewDaemon({
  endpoint: 'http://127.0.0.1:9400',
  tokenFile: '/absolute/private-directory/token',
});
```

`hostApproval` represents your application approval function. The callback receives
a separate copy of the validated spec. It cannot change the execution inputs.
If supplied, the callback applies to all preview types. Without it, static and
attach previews are allowed. Commands are denied.

The callback must release its own resources when `signal` aborts. A late approval
cannot restart a canceled attempt. Approval does not reserve a filesystem snapshot.

`runtime.close()` stops all owned previews and prevents new work. `client.close()`
only closes client requests. `client.shutdown()` explicitly stops the daemon.
The MCP interface does not expose daemon shutdown.

## Specs

Names match `[a-z][a-z0-9-]{0,47}`. Unknown fields are errors. Library and MCP source
paths must be absolute. The CLI resolves paths from the JSON file or stdin directory.

```json
{ "name": "site", "type": "static", "directory": "/absolute/site", "spa": false }
```

Static previews serve regular files and directory `index.html` files. `spa: true`
uses the root index for missing extensionless routes. Missing assets still return
404. Hidden files, unsafe symlinks, traversal, and directory listings are unavailable.

```json
{
  "name": "app",
  "type": "command",
  "cwd": "/absolute/app",
  "command": ["node", "server.mjs", "--port", "{port}"],
  "env": { "NODE_ENV": "development" },
  "readyPath": "/ready",
  "timeoutMs": 30000
}
```

Commands use argv directly, without a shell. Each literal `{port}` becomes the
allocated port. The command must listen on that port and bind to loopback.
previewd does not add arguments or retry a command after a port conflict.

The environment inherits only `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`,
`LC_ALL`, and `TERM`. Explicit `env` values override these values.
`PORT`, `HOST`, and `PREVIEW_URL` are reserved for previewd.
Other host environment values require explicit `env` entries.

```json
{
  "name": "existing",
  "type": "attach",
  "url": "http://127.0.0.1:3000/",
  "readyPath": "/",
  "timeoutMs": 30000
}
```

Attachment accepts `127.0.0.1`, `localhost`, or one lowercase `.localhost` label,
with an explicit HTTP port. All connections use IPv4 loopback.
The supplied authority becomes the upstream Host header. HTTPS, IPv6, credentials,
paths, queries, and fragments are unsupported.

Command and attach readiness requires HTTP 200–399 response headers. It does not
follow redirects or read the body. `readyPath` defaults to `/`.
`timeoutMs` defaults to 30,000 and accepts 100–120,000. Readiness runs once during
startup. Attachment status is not a continuous health check.

## Methods

| Method | Result and effect |
| --- | --- |
| `inspect(spec)` | Validated public description. No execution or permission grant. Environment key names appear without values. |
| `start(spec)` | Reserves a candidate and returns `PreviewStatus` before startup finishes. |
| `replace(name, spec)` | Starts one candidate while the active route remains available. Names must match. |
| `get(name)` | Current `PreviewStatus`. |
| `list()` | Current and retained terminal status records. |
| `wait(name, attemptId, { timeoutMs?, signal? })` | Exact `AttemptResult`. Default and maximum wait: 30 seconds. |
| `logs(name, attemptId?, maxBytes?)` | `{ name, attemptId, text, truncated }`. Default and maximum: 65,536 bytes. |
| `cancel(name, attemptId)` | Cancels that pending candidate and joins cleanup. A stale ID fails. |
| `stop(name)` | Stops all attempts for that name and joins owned cleanup. Repeated stop retries incomplete cleanup. |

`PreviewStatus` contains `name`, `busy`, and optional `url`, `active`, `candidate`,
`latest`, and `cleanup`. `cleanup` lists attempt IDs and errors that require repair.
Attempt summaries contain `id`, `type`, `state`, `startedAt`, optional `readyAt`,
and optional `{ code, message }` error.

Attempt states are `starting`, `ready`, `failed`, `canceled`, `stopped`, and
`cleanup-incomplete`. `AttemptResult` adds `name` and the URL when that attempt
is still active. `wait` finishes after candidate work and old-target cleanup.
Its timeout or abort only removes that wait.

During replacement, new requests use the candidate after successful readiness.
Old requests receive up to one second to drain. The name stays busy through
retirement. If retirement fails, the new route remains active and status reports
`cleanup-incomplete`. Further replacement requires a successful stop.

The runtime retains active attempts, candidates, cleanup handles, and the latest
outcome for each name. It does not retain every historical replacement.
At most 128 inactive names remain. Unknown or expired attempt IDs return
`ATTEMPT_EXPIRED`, never a different attempt result.

## CLI

Run `previewd --help` for the complete syntax. Results use JSON on stdout.
Errors use `{ "error": { "code": "...", "message": "..." } }` on stderr.
Successful commands exit 0. Errors exit nonzero. An interrupted client exits 130.

`start` and `replace` wait by default. `--no-wait` returns the starting status.
`--timeout-ms` controls this wait, separately from the spec readiness timeout.
An error after a successful start request includes the name and attempt ID.
`wait` returns a terminal outcome as JSON, including failed outcomes.

```sh
previewd inspect --file preview.json
previewd start --file preview.json --no-wait
previewd wait app ATTEMPT_ID --timeout-ms 30000
previewd replace --file preview.json
previewd get app
previewd logs app ATTEMPT_ID --max-bytes 8192
previewd cancel app ATTEMPT_ID
previewd stop app
```

All client commands accept `--endpoint` and `--token-file`. Their defaults are
`http://127.0.0.1:9400` and `~/.local/share/previewd/token`.
`serve` accepts repeated `--root`, `--allow-exec`, `--port`, and `--token-file`.
Its default root is the current directory. Port `0` selects an available control
port, which the startup JSON reports.

## HTTP and MCP

The daemon accepts authenticated JSON `POST /METHOD` requests.
The body contains the method arguments, such as `{ "spec": { ... } }` or
`{ "name": "app", "attemptId": "...", "timeoutMs": 30000 }`.
`list` and `shutdown` take `{}`. Successful responses contain `{ "result": ... }`.
Failures contain `{ "error": { "code": "...", "message": "..." } }`.

Control requests require `Authorization: Bearer TOKEN`, `Content-Type: application/json`,
the exact numeric Host header, and no Origin header. Use a trusted local HTTP
client, the library client, or the CLI. This is not a browser control API.

MCP tools use the names `preview_inspect`, `preview_start`, `preview_replace`,
`preview_list`, `preview_get`, `preview_wait`, `preview_logs`, `preview_cancel`,
and `preview_stop`. Arguments match the HTTP method arguments.
Both `structuredContent` and the text fallback contain the response envelope.
Tool failures also set `isError: true`.

## Errors and limits

Errors use stable `PreviewError.code` values. Do not parse error messages.

`INVALID_INPUT`, `SOURCE_DENIED`, `EXECUTION_DENIED`, `ALREADY_EXISTS`, `BUSY`,
`NOT_FOUND`, `STALE_ATTEMPT`, `ATTEMPT_EXPIRED`, `UNSUPPORTED_PLATFORM`,
`START_FAILED`, `TIMEOUT`, `CLEANUP_INCOMPLETE`, `UNAUTHORIZED`,
`DAEMON_UNAVAILABLE`, and `CLOSED` are the public error codes.

There are at most 32 live names, 128 inactive names, and 64 KiB of logs per attempt.
Each gateway permits 256 connections and in-flight requests. Upstream response
headers and WebSocket handshakes have a 10-second deadline. Active streams do not.
Control bodies and responses have a 1 MiB limit. The daemon permits 32 active
requests, including at most 16 waits, with two slots reserved for cleanup.

After a lost mutation response, call `get` or `list` before another mutation.
A transport failure does not prove that the original operation failed.
