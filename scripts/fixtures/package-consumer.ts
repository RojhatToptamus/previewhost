import { createPreviewRuntime, connectPreviewDaemon, loadPreviewSpec, type PreviewSpec, type PreviewApi } from 'previewd';
const spec: PreviewSpec = { name: 'task-42', type: 'command', cwd: '/absolute/task', command: ['node', 'server.mjs'] };
async function describe(api: PreviewApi) { return api.inspect(spec); }
void describe;
void createPreviewRuntime;
void connectPreviewDaemon;
void loadPreviewSpec;
