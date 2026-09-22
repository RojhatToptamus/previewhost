import assert from 'node:assert/strict';
import { Docker } from '../dist/docker.js';
const docker = await Docker.connect(process.env.PREVIEWHOST_TEST_DOCKER_SOCKET);
for (let sample = 0; sample < 5; sample++) {
  for (const tag of ['postgres:17-alpine', 'redis:7-alpine']) {
    const results = {};
    for (const mode of sample % 2 ? ['tag', 'list'] : ['list', 'tag']) {
      const start = performance.now();
      if (mode === 'list') {
        const listed = await docker.request('GET', '/images/json');
        assert.equal(listed.status, 200);
        const image = listed.body.find(item => item.RepoTags.includes(tag));
        assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
        const inspected = await docker.request('GET', `/images/${image.Id}/json`);
        assert.equal(inspected.status, 200);
        assert.equal(inspected.body.Id, image.Id);
        results[mode] = image.Id;
      }
      else {
        const found = await docker.request('GET', `/images/docker.io/library/${tag}/json`);
        assert.equal(found.status, 200);
        assert.match(found.body.Id, /^sha256:[a-f0-9]{64}$/);
        results[mode] = found.body.Id;
      }
      console.log(JSON.stringify({benchmark:mode, sample, tag, ms:performance.now()-start}));
    }
    assert.equal(results.tag, results.list, 'The exact tag and existing lookup must resolve the same immutable image.');
  }
}
