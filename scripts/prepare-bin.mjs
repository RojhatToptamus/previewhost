import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);

// Both compiled entry points use the same bundled presentation assets.
for (const output of ['dist', '.local/test-build']) {
  await cp(new URL('../assets/favicon.png', import.meta.url), new URL(`../${output}/favicon.png`, import.meta.url));
  await cp(new URL('../assets/previewhost.svg', import.meta.url), new URL(`../${output}/previewhost.svg`, import.meta.url));
  await cp(new URL('../src/ui-tokens.css', import.meta.url), new URL(`../${output}/ui-tokens.css`, import.meta.url));
  await cp(new URL('../src/fonts/', import.meta.url), new URL(`../${output}/fonts/`, import.meta.url), { recursive: true });
}

await cp(new URL('../dist/dashboard/', import.meta.url), new URL('../.local/test-build/dashboard/', import.meta.url), { recursive: true });

// Materialize the maintained skill's source links for npm, which excludes symlinks.
const skill = new URL('../dist/skills/previewhost/', import.meta.url);
await rm(skill, { recursive: true, force: true });
await mkdir(new URL('references/docs/', skill), { recursive: true });
await cp(new URL('../skills/previewhost/SKILL.md', import.meta.url), new URL('SKILL.md', skill));
for (const file of ['README.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md',
  ...['api', 'jobs', 'integrations', 'recipes', 'worktrees', 'security', 'troubleshooting', 'releasing',
    'introduction', 'installation', 'first-preview', 'mcp', 'databases', 'secrets', 'dashboard', 'library'].map(name => `docs/${name}.md`)]) {
  const destination = new URL(`references/${file}`, skill);
  await mkdir(new URL('.', destination), { recursive: true });
  await cp(new URL(`../${file}`, import.meta.url), destination);
}
for (const directory of ['examples', 'assets']) {
  await cp(new URL(`../${directory}/`, import.meta.url), new URL(`references/${directory}/`, skill), {
    recursive: true,
    filter: source => !['node_modules', '.local', 'dist', '.DS_Store'].includes(basename(source)) && !/\.test\./.test(source),
  });
}
