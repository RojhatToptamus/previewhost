#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPreviewSpec } from '../../dist/index.js';

const usage = `Use existing shared-notes task directories:
  node worktrees.mjs --name NAME --frontend DIR --backend DIR [--file environment.yaml]

The frontend directory contains server.mjs. The backend directory contains api/
and reporting/. The selected file owns commands, bindings, and readiness rules.
The default file is environment.yaml beside this script. Paths resolve from the
current directory. Output is one JSON spec for previewd inspect/start/replace --file -.
This command does not install packages, start previews, or change source files.
`;

try {
  const { values } = parseArgs({ options: {
    name: { type: 'string' }, frontend: { type: 'string' }, backend: { type: 'string' },
    file: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    if (!values.name || !values.frontend || !values.backend) {
      throw new Error('Supply --name, --frontend, and --backend. Run with --help for the directory layout.');
    }
    const spec = await loadPreviewSpec(values.file ?? fileURLToPath(new URL('environment.yaml', import.meta.url)));
    if (spec.type !== 'environment' || ['frontend', 'api', 'reporting'].some((id) => spec.services[id]?.type !== 'command')) {
      throw new Error('Use a shared-notes environment with frontend, api, and reporting command services.');
    }
    spec.name = values.name;
    spec.services.frontend.cwd = resolve(values.frontend);
    spec.services.api.cwd = resolve(values.backend, 'api');
    spec.services.reporting.cwd = resolve(values.backend, 'reporting');
    process.stdout.write(`${JSON.stringify(spec)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
