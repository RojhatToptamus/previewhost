import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPages, repository } from './content.mjs';
import { pagePath } from './pages.mjs';
import { siteSettings } from './site.mjs';
import { Marked } from 'marked';

const { base, url: publicUrl } = siteSettings();
assert.equal(siteSettings({ DOCS_URL: 'https://docs.example.test/guide' }).base, '/guide/');
for (const DOCS_URL of ['http://docs.example.test/', 'https://user:password@docs.example.test/', 'https://docs.example.test/?preview=1', 'https://docs.example.test/#guide']) {
  assert.throws(() => siteSettings({ DOCS_URL }));
}
assert.throws(() => siteSettings({ DOCS_URL: 'https://docs.example.test/guide/', DOCS_BASE: '/' }));
const output = resolve(repository, '.local/docs-site');
const pages = loadPages(base);
let links = 0;
const titles = new Set();
const descriptions = new Set();
const canonicalUrls = [];
for (const page of pages) {
  const pathname = pagePath(page.id, base);
  const file = resolve(output, pathname.slice(base.length), 'index.html');
  const html = readFileSync(file, 'utf8');
  assert.equal((html.match(/<h1>/g) ?? []).length, 1, `${page.id}: one page title`);
  assert(!html.includes('Task Monki documentation'), `${page.id}: stale branding`);
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  const meta = (name) => {
    const values = [...html.matchAll(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`, 'g'))];
    assert.equal(values.length, 1, `${page.id}: exactly one ${name}`);
    return values[0][1];
  };
  const description = meta('description');
  assert(title && !titles.has(title), `${page.id}: a unique title`);
  assert(description && !descriptions.has(description), `${page.id}: a unique description`);
  titles.add(title); descriptions.add(description);
  assert.equal(meta('og:title'), title);
  assert.equal(meta('twitter:title'), title);
  assert.equal(meta('og:description'), description);
  assert.equal(meta('twitter:description'), description);
  assert.equal(meta('twitter:card'), 'summary_large_image');
  assert.equal(meta('og:image'), meta('twitter:image'));
  assert.equal(meta('og:image:width'), '1200');
  assert.equal(meta('og:image:height'), '630');
  assert(meta('og:image:alt')); assert(meta('twitter:image:alt'));
  const canonical = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
  if (publicUrl) {
    const expected = new URL(pathname, publicUrl).href;
    assert.deepEqual(canonical.map(match => match[1]), [expected]);
    assert.equal(meta('og:url'), expected);
    assert.equal(meta('og:image'), new URL(`${base}social-card.png`, publicUrl).href);
    assert.equal(meta('robots'), 'index, follow, max-image-preview:large');
    const structured = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.equal(structured.url, expected);
    assert.equal(structured.headline, page.title);
    canonicalUrls.push(expected);
  } else {
    assert.equal(canonical.length, 0);
    assert.equal(meta('robots'), 'noindex, nofollow');
  }
  const markdown = readFileSync(resolve(file, '../index.md'), 'utf8');
  const parser = new Marked();
  const code = (text) => {
    const blocks = [];
    parser.walkTokens(parser.lexer(text), token => { if (token.type === 'code' || token.type === 'codespan') blocks.push(token.text); });
    return blocks;
  };
  assert.deepEqual(code(markdown), code(page.markdown), `${page.id}: Markdown preserves code examples`);
  parser.walkTokens(parser.lexer(markdown), token => {
    if (token.type !== 'link' && token.type !== 'image') return;
    if (/^(https?:|mailto:)/.test(token.href)) return;
    const target = new URL(token.href, `http://docs.test${pathname}index.md`);
    assert(target.pathname.startsWith(base), `${page.id}: Markdown link escapes deployment prefix`);
    assert(existsSync(resolve(output, target.pathname.slice(base.length))), `${page.id}: missing Markdown target ${token.href}`);
  });
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

const favicon = readFileSync(resolve(output, 'favicon.png'));
assert.equal(favicon.readUInt32BE(16), 64);
assert.equal(favicon.readUInt32BE(20), 64);
assert.deepEqual(favicon, readFileSync(resolve(repository, 'assets/favicon.png')));

const card = readFileSync(resolve(output, 'social-card.png'));
assert.equal(card.readUInt32BE(16), 1200);
assert.equal(card.readUInt32BE(20), 630);
const llms = readFileSync(resolve(output, 'llms.txt'), 'utf8');
assert(llms.startsWith('# Previewhost\n\n> '));
assert.equal((llms.match(/^- \[/gm) ?? []).length, pages.length);
for (const page of pages) {
  const path = `${pagePath(page.id, base)}index.md`;
  assert(llms.includes(`](${publicUrl ? new URL(path, publicUrl).href : path}): `));
}
const robots = readFileSync(resolve(output, 'robots.txt'), 'utf8');
if (publicUrl) {
  const sitemap = readFileSync(resolve(output, 'sitemap.xml'), 'utf8');
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), canonicalUrls);
  assert(robots.includes(`Sitemap: ${new URL(`${base}sitemap.xml`, publicUrl).href}`));
  assert(!robots.includes('Disallow: /'));
} else {
  assert(!existsSync(resolve(output, 'sitemap.xml')));
  assert(robots.includes('Allow: /'), 'Crawlers must be able to read the noindex directive.');
}
const missing = readFileSync(resolve(output, '404.html'), 'utf8');
assert(missing.includes('<meta name="robots" content="noindex"'));
assert(!missing.includes('rel="canonical"'));

const cache = mkdtempSync(join(tmpdir(), 'previewhost-docs-pack-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const excluded = pack.files.filter(({ path }) => /^(website|docs|assets|\.local)\//.test(path));
  assert.deepEqual(excluded, [], 'The npm package must not contain documentation website files.');
  const pkg = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
  assert(!pkg.dependencies.marked, 'Markdown is a build dependency only.');
  console.log(`Checked ${pages.length} pages, metadata, Markdown, llms.txt, crawler files, ${links} local links/assets/anchors, and npm exclusions.`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
