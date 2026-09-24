import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

export type ProjectGit = { commonDirectory: string; root: string; branch?: string };
const exec = promisify(execFile);

/** Read-only display identity. It never authorizes a source or changes an owner. */
export async function readProjectGit(project: string, signal?: AbortSignal): Promise<ProjectGit | undefined> {
  // A dashboard launched inside another worktree must not inherit that Git context.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args: string[]) => exec('git', ['-C', project, ...args], {
    env, signal, timeout: 2000, maxBuffer: 8192, encoding: 'utf8',
  });
  try {
    const { stdout } = await git('rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir');
    const paths = stdout.trimEnd().split('\n');
    if (paths.length !== 2 || !paths.every(isAbsolute)) return;
    const [root, commonDirectory] = await Promise.all(paths.map(path => realpath(path)));
    // Detached HEAD is still the same repository; a branch is only a display label.
    const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD')
      .then(result => result.stdout.trimEnd() || undefined, () => undefined);
    return { root, commonDirectory, branch };
  } catch {
    // Missing Git, deleted sources and unsafe/unreadable repositories keep folder identity.
    return;
  }
}
