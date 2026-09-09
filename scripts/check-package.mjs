import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const tarball = process.argv[2];
if (!tarball || process.argv.length !== 3) throw new Error('Usage: npm run check:package -- /absolute/path/to/previewhost-VERSION.tgz');
const candidate = await realpath(tarball);
const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost package ')));
assert(relative(repository, directory).startsWith('..'), 'The consumer must be outside the source repository.');
console.log(`Checking ${candidate} in ${directory}`);
function run(command, args) {
  execFileSync(command, args, { cwd: directory, stdio: 'inherit', timeout: 180_000 });
}
let passed = false;
try {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await copyFile(new URL('fixtures/package-consumer.mjs', import.meta.url), join(directory, 'consumer.mjs'));
  await copyFile(new URL('fixtures/package-consumer.ts', import.meta.url), join(directory, 'consumer.ts'));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', candidate]);
  run(process.execPath, ['consumer.mjs']);
  const { devDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', `typescript@${devDependencies.typescript}`, `@types/node@${devDependencies['@types/node']}`]);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', 'consumer.ts']);
  console.log('Installed package passed: ESM, CLI, MCP, cleanup, and strict TypeScript declarations.');
  passed = true;
} finally {
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Package check failed. Retained ${directory}; verify owned-process cleanup before removing it or retrying preparation there.`);
}
