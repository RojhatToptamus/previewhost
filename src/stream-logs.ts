import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

export function captureOutput(readable: Readable, values: string[], write: (text: string) => void | Promise<void>): Promise<void> {
  let flushed!: () => void;
  const complete = new Promise<void>(resolve => { flushed = resolve; });
  const decoder = new StringDecoder('utf8');
  // Match the UTF-8 value delivered by spawn, including replacement characters
  // for malformed surrogate input; encodeURIComponent must never break cleanup.
  const secrets = [...new Set(values.filter(Boolean).flatMap((raw) => {
    const value = Buffer.from(raw).toString('utf8');
    return [value, encodeURIComponent(value)];
  }))].sort((a, b) => b.length - a.length);
  const pattern = secrets.length ? new RegExp(secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  const carrySize = Math.max(0, ...secrets.map((value) => value.length - 1));
  let pending = '';
  let writes = Promise.resolve();

  async function append(value: string, final = false) {
    const text = pending + value;
    let end = completeCodePointEnd(text, final ? text.length : Math.max(0, text.length - carrySize));
    const parts: string[] = [];
    let position = 0;
    if (pattern) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match && match.index < end; match = pattern.exec(text)) {
        parts.push(text.slice(position, match.index), '[REDACTED]');
        position = match.index + match[0].length;
        end = Math.max(end, position);
      }
    }
    parts.push(text.slice(position, end));
    pending = text.slice(end);
    const output = parts.join('');
    for (let offset = 0; offset < output.length;) {
      const end = completeCodePointEnd(output, Math.min(output.length, offset + 16_384));
      await write(output.slice(offset, end));
      offset = end;
    }
  }

  readable.on('data', (chunk: Buffer) => {
    readable.pause();
    writes = writes.then(() => append(decoder.write(chunk))).finally(() => readable.resume());
  });
  readable.once('end', () => {
    writes = writes.then(() => append(decoder.end(), true)).then(flushed);
  });
  return complete;
}

function completeCodePointEnd(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}
