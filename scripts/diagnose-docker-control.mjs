// Read-only API latency control; this does not validate the full preview workflow.
import { Docker } from '../dist/docker.js';

const socket = process.env.PREVIEWHOST_TEST_DOCKER_SOCKET;
if (!socket) throw new Error('Set PREVIEWHOST_TEST_DOCKER_SOCKET to a local Docker Unix socket.');
const docker = await Docker.connect(socket);
const request = docker.request.bind(docker);
let round = 0;
docker.request = async (method, path, ...args) => {
  const label = path === '/info' ? 'info' : path === '/images/json' ? 'image-list'
    : /^\/images\/sha256:[a-f0-9]{64}\/json$/.test(path) ? 'image-inspect' : undefined;
  if (method !== 'GET' || !label) throw new Error('Unexpected Docker control request.');
  const start = performance.now();
  let ok = false;
  try {
    const result = await request(method, path, ...args);
    ok = result.status === 200;
    return result;
  } finally {
    console.log(JSON.stringify({ round, label, durationMs: performance.now() - start, ok }));
  }
};

let engineId;
let imageId;
for (round = 1; round <= 3; round++) {
  const engine = await docker.engineId();
  const image = await docker.image('postgres');
  if ((engineId !== undefined && engine !== engineId) || (imageId !== undefined && image !== imageId)) {
    throw new Error('Docker engine or PostgreSQL image identity changed between rounds.');
  }
  engineId = engine;
  imageId = image;
}
console.log(JSON.stringify({ label: 'control-complete', rounds: 3, identitiesStable: true }));
