import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { limits } from './contracts.js';
import { PreviewError, throwIfAborted } from './errors.js';
import { isPrivate, makePrivateDirectory } from './private-files.js';
import { replaceWindowsProjectRecord } from './windows.js';

export const navigationPreferencesSchema = z.strictObject({
  pinnedProjects: z.array(z.string().min(1).max(4096).refine(id => isAbsolute(id) || /^[a-f0-9]{64}$/.test(id)))
    .max(256).refine(ids => new Set(ids).size === ids.length),
});
export type NavigationPreferences = z.infer<typeof navigationPreferencesSchema>;

/** Display identities only: no path in this list is opened or treated as source authorization. */
export async function navigationPreferences(value?: NavigationPreferences, signal?: AbortSignal): Promise<NavigationPreferences> {
  const directory = join(homedir(), '.local', 'share', 'previewhost', 'dashboard');
  const filename = join(directory, 'navigation.json');
  let temporary: string | undefined;
  try {
    if (signal) throwIfAborted(signal);
    if (value) makePrivateDirectory(directory);
    const root = await lstat(directory);
    if (!root.isDirectory() || !isPrivate(directory, root)) throw new Error('Unsafe preferences directory.');
    if (!value) {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink > 1 || !isPrivate(filename, info) || info.size > limits.controlBytes) throw new Error('Invalid preferences file.');
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return navigationPreferencesSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
      } finally { await file.close(); }
    }
    const preferences = navigationPreferencesSchema.parse(value);
    const text = JSON.stringify(preferences);
    if (Buffer.byteLength(text) > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'Too many pinned projects. Unpin a project before adding another.');
    const candidate = join(directory, `.navigation-${randomUUID()}.tmp`);
    const file = await open(candidate, 'wx', 0o600);
    temporary = candidate;
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    if (signal) throwIfAborted(signal);
    // Whole-list publication is atomic; simultaneous dashboards use the last completed save.
    if (process.platform === 'win32') replaceWindowsProjectRecord(temporary, filename);
    else await rename(temporary, filename);
    temporary = undefined;
    return preferences;
  } catch (error) {
    if (!value && (error as NodeJS.ErrnoException).code === 'ENOENT') return { pinnedProjects: [] };
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', value
      ? 'Could not save pinned projects. Check access to your Previewhost dashboard preferences and retry.'
      : 'Could not read pinned projects. Check your Previewhost dashboard preferences file and permissions.');
  } finally { if (temporary) await unlink(temporary).catch(() => {}); }
}
