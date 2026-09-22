import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// User-approved unpublished test copy. Never applied to checked-in source or a package.
const dataPath = '.local/test-build/data.js';
const data = readFileSync(dataPath, 'utf8');
const guard = /        if \(process\.platform === 'win32'\)\r?\n            throw new PreviewError\('UNSUPPORTED_PLATFORM', 'Windows managed databases are unavailable until Docker pipe server identity can be verified\.'\);/g;
assert.equal([...data.matchAll(guard)].length, 1);
writeFileSync(dataPath, data.replace(guard, ''));

const testPath = '.local/test-build/data.integration.test.js';
let test = readFileSync(testPath, 'utf8');
assert.ok(test.includes("skip: process.platform === 'win32' || !dockerSocket"));
test = test.replace("skip: process.platform === 'win32' || !dockerSocket", 'skip: !dockerSocket');
const permissionCheck = "assert.equal((await stat(join(directory, 'sample.json'))).mode & 0o777, 0o600);";
assert.ok(test.includes(permissionCheck));
test = "import { isPrivate } from './private-files.js';\n" + test.replace(permissionCheck,
  "assert.ok(isPrivate(join(directory, 'sample.json'), await stat(join(directory, 'sample.json'))));");
writeFileSync(testPath, test);
