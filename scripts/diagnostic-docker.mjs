import { appendFileSync } from 'node:fs';
export function observe(Docker) {
  for (const method of ['request', 'attach']) {
    const original = Docker.prototype[method];
    Docker.prototype[method] = async function(...args) {
      const start = performance.now();
      appendFileSync(process.env.PREVIEWHOST_DIAG_FILE, JSON.stringify({ at:Date.now(), pid:process.pid, event:'begin', operation:method, method:args[0], path:method==='request'?args[1].split('?')[0]:undefined })+'\n');
      let result, error;
      try { return result = await original.apply(this, args); }
      catch (cause) { error = cause; throw cause; }
      finally {
        appendFileSync(process.env.PREVIEWHOST_DIAG_FILE, JSON.stringify({ at:Date.now(), pid:process.pid, operation:method, method:method==='request'?args[0]:undefined, path:method==='request'?args[1].split('?')[0]:undefined, ms:Math.round(performance.now()-start), status:result?.status, error:error?.code })+'\n');
      }
    };
  }
}

export function trace(operation, original) {
  return async function(...args) {
    const start = performance.now();
    const key = typeof args[0] === 'string' ? args[0] : args[0]?.name;
    appendFileSync(process.env.PREVIEWHOST_DIAG_FILE, JSON.stringify({ at:Date.now(), pid:process.pid, event:'begin', operation, key })+'\n');
    let error;
    try { return await original.apply(this, args); }
    catch(cause) { error=cause; throw cause; }
    finally { appendFileSync(process.env.PREVIEWHOST_DIAG_FILE, JSON.stringify({ at:Date.now(), pid:process.pid, event:'end', operation, key, ms:Math.round(performance.now()-start), error:error?.code })+'\n'); }
  };
}
