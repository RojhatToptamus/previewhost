import { spawn } from 'node:child_process';
import { PreviewError } from './errors.js';

/** Native delivery only: callers must never print capability URLs. */
export async function openLocalBrowser(url: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'SystemRoot']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', env });
    let failed = false;
    const abort = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(abort, 5000);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => { failed = true; });
    child.once('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failed || code !== 0) reject(new PreviewError('START_FAILED', 'The browser could not open. Retry from the local launcher.'));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}
