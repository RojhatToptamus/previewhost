import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { discoverTestFiles, partitionTestFiles } from './test-groups.mjs';

test('CI groups cover every discovered test exactly once, including newly added native files', async () => {
  const files = [...await discoverTestFiles(), '.local/test-build/new-native.test.js'];
  const groups = partitionTestFiles(files);
  const selected = Object.values(groups).flat();
  assert.deepEqual([...selected].sort(), [...files].sort());
  assert.equal(new Set(selected).size, files.length);
  assert.ok(groups.native.includes('.local/test-build/new-native.test.js'));
  assert.ok(groups.native.includes('scripts/verify-release.test.mjs'));
  assert.ok(groups.project.includes('examples/multi-repo/worktrees.integration.test.mjs'));
  assert.throws(() => partitionTestFiles(files.filter(file => !file.endsWith('/data.integration.test.js'))), /Required database test is missing/);
  assert.throws(() => partitionTestFiles([...files, files[0]]), /duplicate files/);
});

test('workflow executes every group and gates publication on every mandatory job', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const release = YAML.parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const groups = partitionTestFiles(await discoverTestFiles());
  assert.deepEqual([...workflow.jobs.database.strategy.matrix.group, 'native'].sort(), Object.keys(groups).sort());
  assert.equal(workflow.jobs.database.strategy['fail-fast'], false);
  assert.ok(workflow.jobs.database.steps.some(step => step.run === 'node scripts/test-groups.mjs "${{ matrix.group }}"'));
  assert.ok(workflow.jobs.package.steps.some(step => step.run === 'node scripts/test-groups.mjs native'));
  assert.ok(workflow.jobs.docs.steps.some(step => step.run === 'npm run typecheck'));
  assert.deepEqual([...workflow.jobs.verify.needs].sort(), ['database', 'docs', 'package']);
  assert.equal(workflow.jobs.verify.if, 'always()');
  const gate = workflow.jobs.verify.steps.find(step => step.name === 'Require every verification job');
  assert.equal(gate.env.JOB_RESULTS, '${{ toJSON(needs) }}');
  assert.equal(gate.env.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(gate.env.RELEASE_PLAN, '${{ inputs.publish-plan-artifact-id }}');
  assert.ok(gate.run.includes('checkRequiredJobs(JSON.parse(process.env.JOB_RESULTS), process.env.EVENT_NAME, process.env.RELEASE_PLAN)'));
  assert.equal(workflow.on.workflow_call.outputs['pack-dir-artifact-id'].value, '${{ jobs.verify.outputs.pack-dir-artifact-id }}');
  assert.equal(workflow.jobs.verify.outputs['pack-dir-artifact-id'], '${{ needs.package.outputs.pack-dir-artifact-id }}');
  assert.equal(workflow.jobs.package.outputs['pack-dir-artifact-id'], '${{ steps.upload.outputs.artifact-id }}');
  assert.equal(release.jobs.publish.needs, 'verify');
  assert.equal(release.jobs.publish.steps.find(step => step.uses === 'changesets/action/publish@v2').with['pack-dir-artifact-id'], '${{ needs.verify.outputs.pack-dir-artifact-id }}');
});
