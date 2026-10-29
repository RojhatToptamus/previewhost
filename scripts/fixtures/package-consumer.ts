import { applicationSupervisorFiles, createPreviewRuntime, connectPreviewDaemon, loadPreviewSpec, savePreviewSpec, type ApplicationProcessLauncher, type PreviewSpec, type PreviewApi, type SupervisorChannel } from 'previewhost';
const spec: PreviewSpec = { name: 'task-42', type: 'command', cwd: '/absolute/task', command: ['node', 'server.mjs'] };
async function describe(api: PreviewApi) { return api.inspect(spec); }
void describe;
void createPreviewRuntime;
const launcher: ApplicationProcessLauncher = {
  baseEnvironment: { PATH: '/usr/bin:/bin', HOME: '/absolute/task-home' },
  async start({ module, env, cwd, signal }): Promise<SupervisorChannel> { throw new Error(`${module} ${Object.keys(env)} ${cwd} ${signal.aborted} ${applicationSupervisorFiles().files}`); },
};
void launcher;
void connectPreviewDaemon;
void loadPreviewSpec;
async function saveConfiguration() {
  const saved = await savePreviewSpec(spec, { projectDirectory: '/absolute/task', allowedRoots: ['/absolute/task'] });
  await loadPreviewSpec(saved.file);
  return (await connectPreviewDaemon().info())?.projectDirectory;
}
void saveConfiguration;
