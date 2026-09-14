import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';

export const { version } = JSON.parse(readFileSync(findPackageJSON('.', import.meta.url)!, 'utf8')) as { version: string };
