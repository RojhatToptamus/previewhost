// Temporary operation timing for the isolated CI diagnosis; never log arguments or results.
export async function traceStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const emit = (event: string) => process.stderr.write(`DIAG ${JSON.stringify({ pid: process.pid, label, event, at: Date.now(), elapsedMs: Math.round(performance.now() - started) })}\n`);
  emit('begin');
  try { const result = await operation(); emit('end'); return result; }
  catch (error) { emit('error'); throw error; }
}
