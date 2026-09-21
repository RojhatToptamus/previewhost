# Node.js library

Serve a local page, check its response, and stop the preview from a Node.js program.

## Install and prepare a page

Use macOS with Node.js 22.23 or later. This example needs no global CLI, MCP registration, or Docker.
Create an example directory:

```sh
mkdir previewhost-library
cd previewhost-library
npm init -y
npm install previewhost
mkdir site
printf '<h1>Hello from Previewhost.</h1>\n' > site/index.html
```

## Start a preview

Save this as `preview.mjs` beside the `site` directory:

```js
import { resolve } from 'node:path';
import { createPreviewRuntime } from 'previewhost';

const runtime = await createPreviewRuntime({
  allowedRoots: [process.cwd()],
});

try {
  const started = await runtime.start({
    name: 'site',
    type: 'static',
    directory: resolve('site'),
  });
  const ready = await runtime.wait('site', started.candidate.id);
  if (ready.state !== 'ready') throw new Error(JSON.stringify(ready.error));

  const response = await fetch(ready.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(await response.text());
} finally {
  await runtime.close();
}
```

Run the program from that directory:

```sh
node preview.mjs
```

The program prints `<h1>Hello from Previewhost.</h1>` and stops the preview.
`start` returns before startup finishes. `wait` follows the returned attempt ID until startup succeeds or fails.
If the request fails, the `finally` block still closes the runtime.
For a longer-lived preview, keep the runtime open until your application finishes with it.

## Run your application

The runtime accepts the same [spec types](api.md#specs) as the CLI and MCP: `static`, `command`, `attach`, and `environment`.
Direct specs require absolute source paths within `allowedRoots`.
To reuse a file, import `loadPreviewSpec` from `previewhost` and pass its result to `runtime.start`:

```js
const spec = await loadPreviewSpec('./preview.yaml');
```

File paths resolve relative to the configuration file. See [Write preview.yaml](recipes.md) for commands, readiness checks, and service connections.

Native commands and managed databases require an `authorize` callback in `createPreviewRuntime`.
The callback must decide whether to allow the requested operation. Without it, these operations fail with `EXECUTION_DENIED`.
Managed databases also require `dataDirectory`, a private directory outside the source tree, and the [database prerequisites](databases.md#prepare-docker).
See [runtime configuration](api.md#runtime-and-client) for callback arguments and selected inputs.

For stored secrets, select the exact reference names in `secretIds` when you create the runtime.
Stored secrets and managed databases also require an unlocked `runtime.keystore` session.
`runtime.keystore.status()` reports `new`, `locked`, or `unlocked` and attempts remembered automatic unlock on macOS.
For an existing locked keystore, collect the password through your host's private input.
Call `runtime.keystore.unlock({ password })` before startup.

Use [keystore setup](secrets.md) to create storage before this workflow. Unlocking the CLI or dashboard does not unlock this runtime.
`runtime.close()` also closes its keystore session.

## Connect to an existing daemon

Use `connectPreviewDaemon` to control a daemon that already runs. It implements the same `PreviewApi` interface as the runtime.

```js
import { connectPreviewDaemon } from 'previewhost';

const client = connectPreviewDaemon({
  endpoint: 'http://127.0.0.1:9400',
  tokenFile: '/absolute/private-directory/token',
});

try {
  console.log(await client.list());
} finally {
  await client.close();
}
```

Replace the endpoint and token path with those of your daemon.
`client.close()` ends client requests and leaves previews active. `client.shutdown()` stops the daemon and its previews.
