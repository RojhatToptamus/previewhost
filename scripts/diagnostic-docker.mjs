import { appendFileSync } from 'node:fs';
for (const path of ['../dist/docker.js', '../.local/test-build/docker.js']) {
  const { Docker } = await import(new URL(path, import.meta.url));
  for (const method of ['request', 'attach']) {
    const original = Docker.prototype[method];
    Docker.prototype[method] = async function(...args) {
      const start = performance.now();
      let result, error;
      try { return result = await original.apply(this, args); }
      catch (cause) { error = cause; throw cause; }
      finally {
        appendFileSync(process.env.PREVIEWHOST_DIAG_FILE, JSON.stringify({ pid:process.pid, operation:method, method:method==='request'?args[0]:undefined, path:method==='request'?args[1].split('?')[0]:undefined, ms:Math.round(performance.now()-start), status:result?.status, error:error?.code })+'\n');
      }
    };
  }
}
