import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectGit } from './dashboard-identity.js';

test('dashboard identity groups real linked worktrees, not clones or matching names', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-identity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, stdio: 'pipe' });
  const root = join(directory, 'store');
  await mkdir(root);
  git(root, 'init', '-b', 'main');
  const main = { root, commonDirectory: join(root, '.git'), branch: 'main' };
  assert.deepEqual(await readProjectGit(root), main); // An unborn branch is still identifiable.
  git(root, 'commit', '--allow-empty', '-m', 'Fixture');
  const checkout = join(directory, 'trees', 'checkout');
  git(root, 'worktree', 'add', '-b', 'feature/checkout', checkout);
  assert.deepEqual(await readProjectGit(checkout), { ...main, root: checkout, branch: 'feature/checkout' });
  const nested = join(checkout, 'apps', 'frontend');
  await mkdir(nested, { recursive: true });
  assert.deepEqual(await readProjectGit(nested), { ...main, root: checkout, branch: 'feature/checkout' });
  git(checkout, 'checkout', '--detach');
  assert.deepEqual(await readProjectGit(checkout), { ...main, root: checkout, branch: undefined });
  const unrelated = join(directory, 'another', 'store');
  await mkdir(unrelated, { recursive: true });
  git(root, 'clone', '--local', root, unrelated);
  assert.notEqual((await readProjectGit(unrelated))!.commonDirectory, main.commonDirectory);
  const oldDir = process.env.GIT_DIR, oldWorktree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(unrelated, '.git'); process.env.GIT_WORK_TREE = unrelated;
  try { assert.deepEqual(await readProjectGit(root), main); }
  finally {
    if (oldDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldDir;
    if (oldWorktree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldWorktree;
  }
  assert.equal(await readProjectGit(directory), undefined);
  await rm(checkout, { recursive: true });
  assert.equal(await readProjectGit(checkout), undefined);
  const aborted = AbortSignal.abort();
  assert.equal(await readProjectGit(root, aborted), undefined);
});
