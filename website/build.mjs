import { build, createServer } from 'vite';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadPages, repository, escapeHtml } from './content.mjs';

const configFile = resolve(repository, 'website/vite.config.mjs');
const base = process.env.DOCS_BASE || '/';
if (!base.startsWith('/') || !base.endsWith('/') || base.includes('..')) {
  throw new Error('DOCS_BASE must be an absolute URL path with a trailing slash.');
}
await build({ configFile });
const output = resolve(repository, '.local/docs-site');
const template = await readFile(resolve(output, 'index.html'), 'utf8');
const server = await createServer({ configFile, server: { middlewareMode: true, ws: false }, appType: 'custom' });
try {
  const { render } = await server.ssrLoadModule('/src/render.tsx');
  const pages = loadPages(base);
  for (const page of pages) {
    const html = template
      .replace('<div id="root"></div>', () => `<div id="root">${render(page.id)}</div>`)
      .replace(/<title>.*?<\/title>/, () => `<title>${escapeHtml(page.title)} · Previewhost</title>`)
      .replace(/<meta name="description" content="[^"]*"/, () => `<meta name="description" content="${escapeHtml(page.description)}"`);
    const file = resolve(output, page.id === 'welcome' ? 'index.html' : `${page.id}/index.html`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  await cp(resolve(repository, 'website/LICENSE'), resolve(output, 'LICENSE.txt'));
  const notFound = template
    .replace('<div id="root"></div>', () => `<div id="root">${render('not-found')}</div>`)
    .replace(/<title>.*?<\/title>/, '<title>Page not found · Previewhost</title>')
    .replace('</head>', '<meta name="robots" content="noindex" /></head>');
  await writeFile(resolve(output, '404.html'), notFound);
  console.log(`Built ${pages.length} documentation pages in ${output}`);
} finally {
  await server.close();
}
