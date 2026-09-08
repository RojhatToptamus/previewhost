import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function checkReleasePrerequisites(platform, socket) {
  if (platform !== 'darwin') throw new Error('Release verification requires macOS.');
  if (!socket?.trim()) throw new Error('Set PREVIEWD_TEST_DOCKER_SOCKET to the local Docker Unix socket before release verification.');
  if (!(await stat(socket)).isSocket()) throw new Error('PREVIEWD_TEST_DOCKER_SOCKET must select a local Docker Unix socket.');
}

export function checkReleaseResult(code, output) {
  if (code !== 0) throw new Error(`Release verification failed (exit ${code}).`);
  // npm test explicitly selects Node's TAP reporter. Require its final summary,
  // so a missing/truncated test run cannot look like successful verification.
  const counts = {};
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)) counts[match[1]] = Number(match[2]);
  if (!(counts.tests > 0) || counts.pass !== counts.tests ||
      ['fail', 'cancelled', 'skipped', 'todo'].some((key) => counts[key] !== 0)) {
    throw new Error(`Release verification requires a complete test summary with zero failures, cancellations, skips, or TODOs: ${JSON.stringify(counts)}`);
  }
  return counts.tests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkReleasePrerequisites(process.platform, process.env.PREVIEWD_TEST_DOCKER_SOCKET);
    const child = spawn('npm', ['run', 'verify'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['inherit', 'pipe', 'inherit'] });
    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => { process.stdout.write(text); tail = (tail + text).slice(-8192); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    console.log(`macOS release verification passed: ${checkReleaseResult(code, tail)} tests, zero skips.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
