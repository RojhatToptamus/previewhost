# Embed the library

Run Previewhost inside a Node.js application without a separate daemon. The same runtime powers CLI and MCP previews.

## Start an environment

Use the files from [Your first preview](first-preview.md), then install Previewhost locally:

```sh
npm install previewhost
```

Save this as `preview.mjs` in the example directory:

```js
import { createPreviewRuntime, loadPreviewSpec } from 'previewhost';

const runtime = await createPreviewRuntime({
  allowedRoots: [process.cwd()],
  authorize: async () => true,
});

try {
  const spec = await loadPreviewSpec('./preview.yml');
  const started = await runtime.start(spec);
  const ready = await runtime.wait(spec.name, started.candidate.id);
  if (ready.state !== 'ready') throw new Error(JSON.stringify(ready.error));
  console.log(ready.url);
  const response = await fetch(new URL('/message', ready.url));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(await response.json());
} finally {
  await runtime.close();
}
```

Run it from that directory:

```sh
node preview.mjs
```

The program starts both servers, requests the backend message through the frontend, then closes the runtime.
`authorize: async () => true` permits every operation in this trusted example.
In an application that accepts untrusted requests, supply an authorization decision for the actual operation.

## Connect to an owner

Use `connectPreviewDaemon` for an existing daemon. Its client implements the same `PreviewApi` interface.
Closing the client only ends its requests. `runtime.close()` stops owned previews, and `client.shutdown()` stops the daemon.

See [Runtime and client](api.md#runtime-and-client) for connection configuration, authorization callbacks, and database requirements.
