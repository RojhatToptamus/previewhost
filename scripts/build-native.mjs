import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Consumers install the packaged binary; compilation belongs to development/builds.
if (process.platform !== 'darwin') process.exit(0);
const testing = process.argv.includes('--test');
const directory = resolve(testing ? '.local/test-build/native' : 'dist/native');
mkdirSync(directory, { recursive: true });
function build(source, filename, definitions = []) {
  const output = `${directory}/${filename}`;
  const args = ['-fobjc-arc', '-Os', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', ...definitions,
    '-framework', 'Foundation', '-framework', 'Security', source, '-o', output];
  for (const [command, commandArgs] of [
    ['/usr/bin/clang', args],
    // Existing Keychain access depends on the helper's signature, not the package name.
    ['/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', `dev.previewd.${filename}`, output]],
  ]) {
    const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
    if (result.error || result.status !== 0) process.exit(result.status || 1);
  }
}
build('native/keychain.m', 'keychain', testing ? ['-DPREVIEWD_KEYCHAIN_TEST'] : []);
if (testing) build('native/keychain-fixture.m', 'keychain-fixture');
