import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { acquireRoot } from './data.js';
import { limits, previewSpecSchema, type EffectiveSpec } from './contracts.js';
import { PreviewError } from './errors.js';
import { recoverNative, type NativeOwnership } from './native.js';

const identity = z.strictObject({ pid: z.number().int().positive(), group: z.number().int().positive(), started: z.string().min(1).max(128), command: z.string().min(1).max(65_536) });
const receipt = z.strictObject({ source: z.string().max(4096).refine(isAbsolute), supervisor: identity, command: identity.optional() }).refine(value =>
  value.supervisor.pid === value.supervisor.group && (!value.command || value.command.group === value.supervisor.group));
const recordSchema = z.strictObject({
  schema: z.literal(1), spec: previewSpecSchema, attemptId: z.uuid(), startedAt: z.iso.datetime(),
  sourceFile: z.string().max(4096).refine(isAbsolute).optional(),
  processes: z.record(z.uuid(), receipt).refine(value => Object.keys(value).length <= limits.liveNodes),
});
type RecordData = z.output<typeof recordSchema>;

/** Retained configuration and cleanup authority only. Reopening never launches applications or jobs. */
export async function openRuntimeRecords(directory: string) {
  if (!isAbsolute(directory)) throw new PreviewError('INVALID_INPUT', 'The runtime state directory must be absolute.');
  const root = await acquireRoot(directory, false, limits.controlBytes);
  const records = new Map<string, RecordData>();
  try {
    for (const [filename, contents] of await root.records()) {
      const parsed = recordSchema.safeParse(JSON.parse(contents));
      if (!parsed.success || filename !== `${parsed.data.spec.name}.json`) throw new Error('Invalid runtime record');
      records.set(parsed.data.spec.name, parsed.data);
    }
  } catch {
    await root.close();
    throw new PreviewError('CLEANUP_INCOMPLETE', 'Runtime state is invalid or unsupported. Preserve the state directory before recovery; no commands were run.');
  }
  // Serialize file publication and the matching memory mutation. Failed writes leave the prior record authoritative.
  let pending: Promise<unknown> = Promise.resolve();
  function update(name: string, change: (current: RecordData | undefined) => RecordData | undefined): Promise<void> {
    const work = pending.then(async () => {
      const next = change(structuredClone(records.get(name)));
      if (next) {
        if (!records.has(name) && records.size >= limits.retainedEnvironments) throw new PreviewError('BUSY', 'Remove a stopped preview before retaining another configuration.');
        await root.write(`${name}.json`, JSON.stringify(recordSchema.parse(next)));
        records.set(name, next);
      } else if (records.has(name)) {
        await root.remove(`${name}.json`);
        records.delete(name);
      }
    });
    pending = work.catch(() => undefined); // Each caller receives its error; the queue remains usable for cleanup retries.
    return work;
  }
  return {
    directory: root.directory,
    entries: () => structuredClone([...records.values()]),
    has: (name: string) => records.has(name),
    save(spec: EffectiveSpec, attemptId: string, startedAt: string, sourceFile?: string) {
      return update(spec.name, previous => ({ schema: 1, spec, attemptId, startedAt, sourceFile, processes: previous?.processes ?? {} }));
    },
    ownership(name: string): NativeOwnership {
      const id = randomUUID();
      return {
        save(value) {
          return update(name, current => {
            if (!current) throw new PreviewError('CLEANUP_INCOMPLETE', 'Native execution requires retained configuration before launch.');
            current.processes[id] = value;
            return current;
          });
        },
        clear: () => update(name, current => { if (current) delete current.processes[id]; return current; }),
      };
    },
    async recover(name: string) {
      const results = await Promise.allSettled(Object.entries(records.get(name)?.processes ?? {}).map(async ([id, value]) => {
        await recoverNative(value);
        await update(name, current => { if (current) delete current.processes[id]; return current; });
      }));
      if (results.some(result => result.status === 'rejected')) throw new PreviewError('CLEANUP_INCOMPLETE', 'Some native resources could not be verified as stopped. Their ownership receipts are retained for retry.');
    },
    remove: (name: string) => update(name, () => undefined),
    async close() { await pending; await root.close(); },
  };
}
export type RuntimeRecords = Awaited<ReturnType<typeof openRuntimeRecords>>;
