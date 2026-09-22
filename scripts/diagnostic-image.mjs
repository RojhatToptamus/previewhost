import assert from 'node:assert/strict';
import { Docker } from '../dist/docker.js';
const docker = await Docker.connect(process.env.PREVIEWHOST_TEST_DOCKER_SOCKET);
for (let sample = 0; sample < 5; sample++) {
  for (const tag of ['postgres:17-alpine', 'redis:7-alpine']) {
    const results = {};
    for (const mode of sample % 2 ? ['tag', 'list'] : ['list', 'tag']) {
      const start = performance.now();
      if (mode === 'list') results[mode] = await docker.image(tag.startsWith('postgres') ? 'postgres' : 'redis');
      else {
        const found = await docker.request('GET', `/images/${encodeURIComponent(tag)}/json`);
        assert.equal(found.status, 200);
        assert.match(found.body.Id, /^sha256:[a-f0-9]{64}$/);
        results[mode] = found.body.Id;
      }
      console.log(JSON.stringify({benchmark:mode, sample, tag, ms:performance.now()-start}));
    }
    assert.equal(results.tag, results.list, 'The exact tag and existing lookup must resolve the same immutable image.');
  }
}
