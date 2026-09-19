import test from 'node:test';
import assert from 'node:assert/strict';
import { AttemptLog } from './logs.js';
import { limits } from './contracts.js';

test('source identity survives forged labels, filtering and incremental reads in capture order', () => {
  const log = new AttemptLog();
  log.append('first\n', 'migrate'); log.append('[migrate] actually api\n', 'api'); log.append('last\n', 'migrate');
  assert.equal(log.read().text, '[migrate] first\n[api] [migrate] actually api\n[migrate] last\n');
  assert.equal(log.read({ source: 'migrate' }).text, 'first\nlast\n');
  assert.equal(log.read({ source: 'missing' }).text, '');
  let cursor = 0; let text = '';
  for (let i = 0; i < 10; i++) {
    const page = log.read({ source: 'migrate', after: cursor, maxBytes: 4 });
    assert.equal(page.truncated, false);
    if (page.cursor === cursor) break;
    cursor = page.cursor; text += page.text;
  }
  assert.equal(text, 'first\nlast\n');
  assert.equal(cursor, log.read().cursor);
  log.append('other\n', 'api');
  const quiet = log.read({ source: 'migrate', after: cursor });
  assert.equal(quiet.text, ''); assert.ok(quiet.cursor > cursor);
  log.append('new\n', 'migrate');
  assert.equal(log.read({ source: 'migrate', after: quiet.cursor }).text, 'new\n');
});

test('retention and page limits preserve UTF-8 and report lost output', () => {
  const log = new AttemptLog();
  log.append('🙂'.repeat(limits.logBytes), 'api');
  const retained = log.read({ source: 'api', after: 0 });
  assert.equal(Buffer.byteLength(retained.text), limits.logBytes); assert.equal(retained.truncated, true);
  assert.ok(!retained.text.includes('�'));
  const tail = log.read({ source: 'api', maxBytes: 5 });
  assert.equal(tail.text, '🙂'); assert.equal(tail.truncated, true);
  const next = log.read({ source: 'api', after: 4 * limits.logBytes - 8, maxBytes: 5 });
  assert.equal(next.text, '🙂'); assert.equal(next.truncated, false);
  assert.equal(log.read({ source: 'api', after: next.cursor }).text, '🙂');
  assert.throws(() => log.read({ after: next.cursor + 1 }), { code: 'INVALID_INPUT' });
  for (const options of [{ after: -1 }, { after: 999999 }, { after: 0.5 }, { maxBytes: 3 }, { maxBytes: 65537 }]) assert.throws(() => log.read(options), { code: 'INVALID_INPUT' });
});

test('tiny interleaved writes are bounded and tail limits distinguish omission from pagination', () => {
  const log = new AttemptLog();
  for (let i = 0; i < 2000; i++) log.append(String(i % 10), i % 2 ? 'api' : 'job');
  assert.equal(log.read({ after: 0 }).truncated, true);
  assert.equal(log.read().text.match(/\[/g)?.length, 1024);
  assert.equal(log.read({ source: 'job', after: 1990 }).text, '02468');
  assert.equal(log.read({ source: 'job', maxBytes: 4 }).text, '2468');
  assert.equal(log.read({ source: 'job', after: 1990, maxBytes: 4 }).text, '0246');
  assert.equal(log.read({ source: 'job', after: 1990, maxBytes: 4 }).truncated, false);
});
