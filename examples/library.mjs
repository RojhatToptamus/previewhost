import { fileURLToPath } from 'node:url';
import { createPreviewRuntime } from 'previewd';

const directory = fileURLToPath(new URL('./site', import.meta.url));
const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
try {
  const started = await runtime.start({ name: 'example', type: 'static', directory });
  const ready = await runtime.wait('example', started.candidate.id);
  if (ready.state !== 'ready') throw new Error(ready.error?.message ?? ready.state);
  console.log(ready.url);
  console.log(await (await fetch(ready.url)).text());
} finally {
  await runtime.close();
}
