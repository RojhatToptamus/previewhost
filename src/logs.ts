import { limits, type LogOptions } from './contracts.js';
import { PreviewError } from './errors.js';

interface Entry { start: number; source: string; bytes: Buffer }

/** One owner per attempt. Offsets count captured UTF-8 bytes, before display labels. */
export class AttemptLog {
  private entries: Entry[] = [];
  private end = 0;

  append(text: string, source: string): void {
    if (!text) return;
    const bytes = Buffer.from(text);
    this.entries.push({ start: this.end, source, bytes });
    this.end += bytes.length;
    // Bound both output and metadata, including many tiny interleaved writes.
    const floor = Math.max(0, this.end - limits.logBytes);
    while (this.entries.length && (this.entries[0].start + this.entries[0].bytes.length <= floor || this.entries.length > 1024)) this.entries.shift();
    const first = this.entries[0];
    if (first && first.start < floor) {
      let cut = floor - first.start;
      while (cut < first.bytes.length && continuation(first.bytes[cut])) cut++;
      first.bytes = Buffer.from(first.bytes.subarray(cut)); first.start += cut;
      if (!first.bytes.length) this.entries.shift();
    }
  }

  read({ source, after, maxBytes = limits.logBytes }: LogOptions = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > limits.logBytes ||
        (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > this.end))) {
      throw new PreviewError('INVALID_INPUT', 'Use maxBytes between 4 and 65536 and a cursor returned by this attempt.');
    }
    if (after !== undefined && this.entries.some(entry => after >= entry.start && after < entry.start + entry.bytes.length && continuation(entry.bytes[after - entry.start]))) {
      throw new PreviewError('INVALID_INPUT', 'Use a cursor returned by this attempt; it must fall on a UTF-8 character boundary.');
    }
    const first = this.entries[0]?.start ?? this.end;
    let truncated = (after ?? 0) < first;
    let remaining = maxBytes;
    let cursor = after ?? this.end;
    const selected = this.entries.filter(entry => (source === undefined || entry.source === source) && entry.start + entry.bytes.length > (after ?? 0));
    // Initial reads return a tail; incremental reads return the next page without skipping output.
    let skip = after === undefined ? Math.max(0, selected.reduce((sum, entry) => sum + entry.bytes.length, 0) - maxBytes) : 0;
    truncated ||= skip > 0;
    const output: string[] = [];
    for (const entry of selected) {
      let start = Math.max(0, (after ?? 0) - entry.start);
      if (skip >= entry.bytes.length) { skip -= entry.bytes.length; continue; }
      if (skip) { start = skip; skip = 0; }
      while (start < entry.bytes.length && continuation(entry.bytes[start])) start++;
      let end = Math.min(entry.bytes.length, start + remaining);
      while (end > start && end < entry.bytes.length && continuation(entry.bytes[end])) end--;
      if (end === start && start < entry.bytes.length) return { text: output.join(''), cursor, truncated };
      if (end > start) output.push((source === undefined ? `[${entry.source}] ` : '') + entry.bytes.subarray(start, end).toString('utf8'));
      remaining -= end - start; cursor = entry.start + end;
      if (end < entry.bytes.length) return { text: output.join(''), cursor, truncated };
    }
    return { text: output.join(''), cursor: this.end, truncated };
  }
}

function continuation(byte: number): boolean { return (byte & 0xc0) === 0x80; }
