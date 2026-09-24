import { build, createServer } from 'vite';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadPages, repository, escapeHtml } from './content.mjs';
import { pagePath, homePage } from './pages.mjs';
import { siteSettings } from './site.mjs';

const configFile = resolve(repository, 'website/vite.config.mjs');
const { base, url } = siteSettings();
const absolute = (path) => url ? new URL(path, url).href : path;

function pageHead(page) {
  const canonical = absolute(pagePath(page.id, base));
  const image = absolute(`${base}social-card.png`);
  const imageAlt = 'Previewhost. Your whole app. One local preview. Frontend, APIs, PostgreSQL, and Redis running locally.';
  const meta = (name, value, attribute = 'name') => `<meta ${attribute}="${name}" content="${escapeHtml(value)}" />`;
  const tags = [
    meta('robots', url ? 'index, follow, max-image-preview:large' : 'noindex, nofollow'),
    `<link rel="alternate" type="text/markdown" href="${escapeHtml(page.id === 'home' ? absolute(pagePath('welcome', base)) : canonical)}index.md" />`,
    `<link rel="describedby" href="${escapeHtml(absolute(`${base}llms.txt`))}" />`,
    meta('og:type', 'website', 'property'),
    meta('og:site_name', 'Previewhost', 'property'),
    meta('og:locale', 'en_US', 'property'),
    meta('og:title', page.documentTitle, 'property'),
    meta('og:description', page.description, 'property'),
    meta('og:image', image, 'property'),
    meta('og:image:type', 'image/png', 'property'),
    meta('og:image:width', '1200', 'property'),
    meta('og:image:height', '630', 'property'),
    meta('og:image:alt', imageAlt, 'property'),
    meta('twitter:card', 'summary_large_image'),
    meta('twitter:title', page.documentTitle),
    meta('twitter:description', page.description),
    meta('twitter:image', image),
    meta('twitter:image:alt', imageAlt),
  ];
  if (url) {
    tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}" />`, meta('og:url', canonical, 'property'));
    const structured = {
      '@context': 'https://schema.org', '@type': page.id === 'home' ? 'WebPage' : 'TechArticle',
      headline: page.title, description: page.description, url: canonical,
      inLanguage: 'en', image,
      isPartOf: { '@type': 'WebSite', name: 'Previewhost', url: url.href },
    };
    tags.push(`<script type="application/ld+json">${JSON.stringify(structured).replaceAll('<', '\\u003c')}</script>`);
  }
  return tags.join('\n    ');
}
await build({ configFile });
const output = resolve(repository, '.local/docs-site');
const template = await readFile(resolve(output, 'index.html'), 'utf8');
const server = await createServer({ configFile, server: { middlewareMode: true, ws: false }, appType: 'custom' });
try {
  const { render } = await server.ssrLoadModule('/src/render.tsx');
  const pages = loadPages(base);
  for (const page of [homePage, ...pages]) {
    const html = template
      .replace('<div id="root"></div>', () => `<div id="root">${render(page.id)}</div>`)
      .replace(/<title>.*?<\/title>/, () => `<title>${escapeHtml(page.documentTitle)}</title>`)
      .replace(/<meta name="description" content="[^"]*"/, () => `<meta name="description" content="${escapeHtml(page.description)}"`)
      .replace('</head>', () => `${pageHead(page)}\n  </head>`);
    const file = resolve(output, pagePath(page.id, '/').slice(1), 'index.html');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
    if (page.publishedMarkdown) await writeFile(resolve(dirname(file), 'index.md'), page.publishedMarkdown);
  }
  // Preserve the existing machine-readable introduction address.
  await writeFile(resolve(output, 'index.md'), pages[0].publishedMarkdown);
  const index = [
    '# Previewhost', '', `> ${pages[0].description}`, '',
    'For coding agents, start with MCP setup. For terminal commands, use CLI quickstart. For a Node.js program, use the library guide.', '',
  ];
  for (const group of [...new Set(pages.map((page) => page.group))]) {
    index.push(`## ${group}`, '');
    for (const page of pages.filter((page) => page.group === group)) {
      index.push(`- [${page.label}](${absolute(`${pagePath(page.id, base)}index.md`)}): ${page.description}`);
    }
    index.push('');
  }
  await writeFile(resolve(output, 'llms.txt'), index.join('\n'));
  if (url) {
    const entries = [homePage, ...pages].map((page) => `  <url><loc>${escapeHtml(absolute(pagePath(page.id, base)))}</loc></url>`);
    await writeFile(resolve(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`);
  }
  await writeFile(resolve(output, 'robots.txt'), url
    ? `User-agent: *\nAllow: /\n\nSitemap: ${absolute(`${base}sitemap.xml`)}\n`
    : 'User-agent: *\nAllow: /\n');
  await cp(resolve(repository, 'website/social-card.png'), resolve(output, 'social-card.png'));
  await cp(resolve(repository, 'website/LICENSE'), resolve(output, 'LICENSE.txt'));
  const notFound = template
    .replace('<div id="root"></div>', () => `<div id="root">${render('not-found')}</div>`)
    .replace(/<title>.*?<\/title>/, '<title>Page not found | Previewhost</title>')
    .replace(/<meta name="description" content="[^"]*"/, '<meta name="description" content="This address does not match a documentation page."')
    .replace('</head>', '<meta name="robots" content="noindex" /></head>');
  await writeFile(resolve(output, '404.html'), notFound);
  console.log(`Built the homepage and ${pages.length} documentation pages in ${output}`);
  console.log(url ? `Public URL: ${url.href}` : 'Local preview build: noindex. Set DOCS_URL to the public HTTPS address before publishing.');
} finally {
  await server.close();
}
