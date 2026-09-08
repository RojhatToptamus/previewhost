import { limits } from './contracts.js';
import { PreviewError, throwIfAborted } from './errors.js';
import { validateSecretValue } from './keychain.js';

/** Reads owner input without placing its value in arguments, prompts or diagnostics. */
export async function readSecretInput(stdin: boolean, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (!stdin && !process.stdin.isTTY) throw new PreviewError('INVALID_INPUT', 'Use --stdin for piped secret bytes or run set in a terminal.');
  if (stdin && process.stdin.isTTY) throw new PreviewError('INVALID_INPUT', '--stdin requires a pipe. Omit it for hidden terminal entry.');
  return new Promise<string>((resolve, reject) => {
    const bytes: number[] = [];
    const wasRaw = process.stdin.isRaw;
    let paste = false;
    let escape = '';
    let finished = false;
    let inputError: PreviewError | undefined;
    function cleanup() {
      process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', error);
      signal.removeEventListener('abort', abort);
      process.stdin.pause();
      if (!stdin) { process.stdin.setRawMode(wasRaw); process.stderr.write('\x1b[?2004l\n'); }
    }
    function done(problem?: Error) {
      if (finished) return;
      finished = true; cleanup();
      try {
        if (problem || inputError) throw problem ?? inputError;
        const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
        validateSecretValue(value);
        resolve(value);
      } catch (cause) { reject(cause instanceof PreviewError ? cause : new PreviewError('INVALID_INPUT', 'Supply valid UTF-8 secret bytes.')); }
      finally { bytes.fill(0); }
    }
    function abort() { done(new PreviewError('CLOSED', 'Secret entry was canceled.')); }
    function error() { done(new PreviewError('INVALID_INPUT', 'Secret input could not be read.')); }
    function end() { done(); }
    function append(byte: number) {
      if (inputError) return;
      bytes.push(byte);
      if (bytes.length > limits.secretBytes) {
        inputError = new PreviewError('INVALID_INPUT', 'A secret can contain at most 4096 UTF-8 bytes.');
        if (stdin) done(inputError);
        // Keep terminal echo disabled through the rest of the paste and submission.
      }
    }
    function data(chunk: Buffer) {
      for (const byte of chunk) {
        if (finished) break;
        if (stdin) { append(byte); continue; }
        if (byte === 3 || byte === 4) { abort(); break; }
        if (escape || byte === 27) {
          escape += String.fromCharCode(byte);
          if (escape === '\x1b[200~') { paste = true; escape = ''; }
          else if (escape === '\x1b[201~') { paste = false; escape = ''; }
          else if (!['\x1b[200~', '\x1b[201~'].some((sequence) => sequence.startsWith(escape))) {
            if (paste) for (const character of escape) append(character.charCodeAt(0));
            escape = '';
          }
          continue;
        }
        if (!paste && (byte === 10 || byte === 13)) { done(); break; }
        if (!paste && (byte === 8 || byte === 127)) {
          let removed = bytes.pop();
          while (removed !== undefined && (removed & 0xc0) === 0x80) removed = bytes.pop();
        } else if (!paste && byte === 21) bytes.length = 0;
        else append(byte);
      }
    }
    if (!stdin) {
      process.stdin.setRawMode(true);
      process.stderr.write('Secret value (hidden; Enter to save): \x1b[?2004h');
    }
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    process.stdin.resume();
    if (signal.aborted) abort();
  });
}
