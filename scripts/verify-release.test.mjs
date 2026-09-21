import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkReleasePrerequisites, checkReleaseResult, checkRequiredJobs } from './verify-release.mjs';

const execute = promisify(execFile);

test('release verification rejects missing prerequisites before running the suite', async () => {
  await assert.rejects(checkReleasePrerequisites('linux', '/unused'), /requires macOS/);
  await assert.rejects(checkReleasePrerequisites('darwin', undefined), /PREVIEWHOST_TEST_DOCKER_SOCKET/);
  await assert.rejects(checkReleasePrerequisites('darwin', fileURLToPath(import.meta.url)), /Unix socket/);
});

test('release verification rejects a successful Node run that skipped tests or lacks a complete summary', async () => {
  // node:test emits a real TAP report for these isolated fixture programs.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const report = async (body) => (await execute(process.execPath, ['--test-reporter=tap', '--input-type=module', '--eval', `import test from 'node:test'; ${body}`], { env })).stdout;
  const passed = await report("test('required', () => {});");
  assert.equal(checkReleaseResult(0, passed), 1);
  const skipped = await report("test('required', { skip: true }, () => {});");
  assert.throws(() => checkReleaseResult(0, skipped), /zero failures, cancellations, skips/);
  const todo = await report("test('required', { todo: true }, () => {});");
  assert.throws(() => checkReleaseResult(0, todo), /zero failures, cancellations, skips/);
  assert.throws(() => checkReleaseResult(0, passed.replace(/^# skipped.*\n/m, '')), /complete test summary/);
  assert.throws(() => checkReleaseResult(1, passed), /exit 1/);
  assert.throws(() => checkReleaseResult(0, skipped + passed), /one complete test summary/);
});

test('required CI gate rejects missing, failed, canceled, or skipped groups and missing release artifacts', () => {
  const jobs = { docs: { result: 'success' }, database: { result: 'success' }, package: { result: 'success', outputs: { 'pack-dir-artifact-id': '123' } } };
  checkRequiredJobs(jobs, true);
  for (const group of Object.keys(jobs)) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.throws(() => checkRequiredJobs({ ...jobs, [group]: { result } }), /Required CI job did not succeed/);
    }
    const missing = { ...jobs }; delete missing[group];
    assert.throws(() => checkRequiredJobs(missing), /Required CI job did not succeed/);
  }
  checkRequiredJobs({ ...jobs, package: { result: 'success' } });
  assert.throws(() => checkRequiredJobs({ ...jobs, package: { result: 'success' } }, true), /exact verified package artifact ID/);
});
