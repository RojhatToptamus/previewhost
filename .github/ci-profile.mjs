// Temporary investigation only. This is not a release-coverage gate.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const directory = resolve('.local/ci-profile');
await mkdir(directory, { recursive: true });
const results = [];
const target = 'real owned PostgreSQL and Redis retain authenticated data across stop/reopen and report unexpected exit';
const save = () => writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2) + '\n');
async function sample(label, instrument = true) {
  const before = performance.now();
  const log = createWriteStream(`${directory}/${label}.log`, { mode: 0o600 });
  const args = [
    ...(instrument ? ['--import', resolve('.github/ci-duration-probe.mjs')] : []),
    '--test', '--test-reporter=tap', '--test-concurrency=1',
    '--test-name-pattern=^real owned PostgreSQL and Redis retain authenticated data',
    '.local/test-build/data.integration.test.js',
  ];
  console.log(`PROFILE_START ${label} ${new Date().toISOString()}`);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const result = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => log.end(() => done({ label, code, signal, seconds: (performance.now() - before) / 1000 })));
  });
  const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)].map(match => [match[1], Number(match[2])]));
  result.valid = result.code === 0 && counts.pass === 1 && counts.fail === 0 && counts.cancelled === 0 && counts.todo === 0
    && output.split(/\r?\n/).some(line => /^ok \d+ - /.test(line) && line.replace(/^ok \d+ - /, '') === target);
  result.counts = counts;
  results.push(result);
  console.log(`PROFILE_END ${JSON.stringify(result)} ${new Date().toISOString()}`);
}
await sample('control', false);
await save();
let serial = 0, pair = 0;
for (const mode of ['serial', 'pair', 'pair', 'serial', 'serial', 'pair']) {
  if (results.some(result => !result.valid)) break;
  if (mode === 'serial') await sample(`serial-${++serial}`);
  else { pair++; await Promise.all([sample(`pair-${pair}-a`), sample(`pair-${pair}-b`)]); }
  await save();
}
process.exitCode = results.some(result => !result.valid) ? 1 : 0;
