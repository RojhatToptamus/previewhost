# Your first preview

Run a frontend that requests a message from a backend. Previewhost supplies both ports and connects the two services.

## Create the example

Complete [installation](installation.md) first. This example requires no Docker or application packages.
Create a new directory outside an existing Git repository:

```sh
mkdir previewhost-demo
cd previewhost-demo
```

Save this as `backend.mjs`:

```js
import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.url !== '/message') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ message: 'Hello from the backend.' }));
}).listen(Number(process.env.PORT), process.env.HOST);
```

Save this as `frontend.mjs`:

```js
import { createServer } from 'node:http';

const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Previewhost demo</title>
<h1>Frontend + backend</h1>
<p id="message" role="status">Connecting…</p>
<script type="module">
  const message = document.querySelector('#message');
  try {
    const response = await fetch('/message');
    if (!response.ok) throw new Error('Backend unavailable');
    message.textContent = (await response.json()).message;
  } catch {
    message.textContent = 'Backend request failed.';
  }
</script>`;

createServer(async (request, response) => {
  if (request.url === '/message') {
    try {
      const reply = await fetch(new URL('/message', process.env.BACKEND_URL), {
        signal: AbortSignal.timeout(2000),
      });
      response.writeHead(reply.status, {
        'content-type': 'application/json', 'cache-control': 'no-store',
      });
      response.end(await reply.text());
    } catch {
      response.writeHead(503).end('Backend unavailable');
    }
  } else if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page);
  } else response.writeHead(404).end();
}).listen(Number(process.env.PORT), process.env.HOST);
```

The frontend forwards `/message` to the backend. Browser requests use the frontend's origin, so this example needs no CORS configuration.

## Describe the services

Save this as `preview.yml` beside the two server files:

```yaml
name: hello
type: environment
primary: frontend
services:
  backend:
    type: command
    cwd: .
    command: [node, backend.mjs]
    readyPath: /message
  frontend:
    type: command
    cwd: .
    command: [node, frontend.mjs]
    readyPath: /message
    env:
      BACKEND_URL: {service: backend}
```

`primary` selects the frontend for the environment URL.
The `service` binding supplies the backend URL and starts the frontend after the backend is ready.
Both servers use Previewhost's `PORT` and `HOST` values.

## Start and inspect

Inspect the recipe, then start it:

```sh
previewhost inspect
previewhost start --allow-exec
```

`--allow-exec` permits these commands to run with your user permissions. It provides no sandbox.
The CLI finds or starts a persistent background owner for this directory.

Open the `url` from the JSON result. The page shows **Frontend + backend**, then **Hello from the backend.**
Readiness checks HTTP headers. Opening the page verifies that the application actually works.

If the result says `starting`, use its attempt ID to continue waiting:

```sh
previewhost get hello
previewhost wait hello ATTEMPT_ID
```

Replace `ATTEMPT_ID` with the ID from the result. A wait timeout does not cancel startup.
To inspect services and logs in the browser, run `previewhost dashboard` in another terminal.

## Try a replacement

Change the backend message in `backend.mjs`. Then run:

```sh
previewhost replace
```

Reload the same URL after the replacement is ready. The new message appears.
These example servers do not reload source automatically. Development servers can have their own reload behavior.

## Stop the example

```sh
previewhost stop hello
previewhost shutdown
```

Stop ends the preview. Shutdown ends this project's owner and all its previews.
The source files remain. For a project with databases, stop also retains managed data.

Next, adapt a [configuration](recipes.md) to your application, or connect your agent through [MCP](mcp.md).
