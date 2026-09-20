import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPages, repository } from './content.mjs';
import { pagePath } from './pages.mjs';

const base = process.env.DOCS_BASE || '/';
const output = resolve(repository, '.local/docs-site');
const pages = loadPages(base);
let links = 0;
for (const page of pages) {
  const pathname = pagePath(page.id, base);
  const file = resolve(output, pathname.slice(base.length), 'index.html');
  const html = readFileSync(file, 'utf8');
  assert.equal((html.match(/<h1>/g) ?? []).length, 1, `${page.id}: one page title`);
  assert(!html.includes('Task Monki documentation'), `${page.id}: stale branding`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${page.id}: duplicate anchors`);
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (/^(https?:|mailto:|data:)/.test(href)) continue;
    const url = new URL(href, `http://docs.test${pathname}`);
    assert(url.pathname.startsWith(base), `${page.id}: link escapes deployment prefix: ${href}`);
    let target = resolve(output, url.pathname.slice(base.length));
    if (url.pathname.endsWith('/')) target = join(target, 'index.html');
    assert(existsSync(target), `${page.id}: missing ${href}`);
    if (url.hash) {
      const content = readFileSync(target, 'utf8');
      assert(content.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${page.id}: missing anchor ${href}`);
    }
    links++;
  }
}

const cache = mkdtempSync(join(tmpdir(), 'previewhost-docs-pack-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const excluded = pack.files.filter(({ path }) => /^(website|docs|assets|\.local)\//.test(path));
  assert.deepEqual(excluded, [], 'The npm package must not contain documentation website files.');
  const pkg = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
  assert(!pkg.dependencies.marked, 'Markdown is a build dependency only.');
  console.log(`Checked ${pages.length} static pages, ${links} local links/assets/anchors, and npm package exclusions.`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
