import { spawn } from 'node:child_process';
import { appendFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkReleasePrerequisites, checkReleaseResult } from './verify-release.mjs';

// Keep real database files explicit. New files join native; a missing Docker
// prerequisite must emit a skip/error, which the complete-result gate rejects.
const databaseFiles = {
  runtime: [
    '.local/test-build/jobs-database.integration.test.js',
    '.local/test-build/data-reset.integration.test.js',
    '.local/test-build/environment-data.integration.test.js',
  ],
  project: [
    '.local/test-build/data.integration.test.js',
    '.local/test-build/project.integration.test.js',
    '.local/test-build/project-database.integration.test.js',
    '.local/test-build/project-lifecycle.test.js',
    'examples/multi-repo/worktrees.integration.test.mjs',
  ],
};

export function partitionTestFiles(files) {
  const discovered = new Set(files);
  if (discovered.size !== files.length) throw new Error('Test discovery contains duplicate files.');
  const assigned = new Set();
  for (const file of Object.values(databaseFiles).flat()) {
    if (!discovered.has(file)) throw new Error(`Required database test is missing: ${file}`);
    if (assigned.has(file)) throw new Error(`Database test belongs to multiple groups: ${file}`);
    assigned.add(file);
  }
  return { ...databaseFiles, native: files.filter(file => !assigned.has(file)) };
}

export async function discoverTestFiles() {
  const directories = [
    ['.local/test-build', '.test.js'],
    ['examples/multi-repo', '.test.mjs'],
    ['scripts', '.test.mjs'],
  ];
  return (await Promise.all(directories.map(async ([directory, suffix]) =>
    (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
      .map(entry => `${directory}/${entry.name}`)))).flat().sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const group = process.argv[2];
    const groups = partitionTestFiles(await discoverTestFiles());
    if (!Object.hasOwn(groups, group) || process.argv.length !== 3) throw new Error('Select a test group: native, runtime, or project.');
    if (group === 'native') {
      if (process.platform !== 'darwin') throw new Error('Native package verification requires macOS.');
      if (process.env.PREVIEWHOST_TEST_DOCKER_SOCKET) throw new Error('Run the native group without PREVIEWHOST_TEST_DOCKER_SOCKET.');
    } else await checkReleasePrerequisites(process.platform, process.env.PREVIEWHOST_TEST_DOCKER_SOCKET);
    const files = groups[group];
    if (!files.length) throw new Error(`Test group is empty: ${group}`);
    console.log(`CI_TEST_FILES ${JSON.stringify({ group, files })}`);
    const started = performance.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['inherit', 'pipe', 'inherit'],
    });
    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { process.stdout.write(text); tail = (tail + text).slice(-8192); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const count = checkReleaseResult(code, tail);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const summary = `${group}: ${count} tests passed, zero skips; ${files.length} files; ${seconds}s.`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
