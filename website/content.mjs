import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { pageSources, pagePath } from './pages.mjs';

export const repository = fileURLToPath(new URL('..', import.meta.url));
export const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const slug = (text) => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s/g, '-');
const plain = (text) => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

export function loadPages(base = '/') {
  return pageSources.map((page) => {
    const markdown = readFileSync(path.join(repository, page.source), 'utf8');
    const parser = new Marked();
    const tokens = parser.lexer(markdown);
    const title = plain(tokens.find((token) => token.type === 'heading')?.text ?? page.label);
    const description = plain(tokens.find((token) => token.type === 'paragraph')?.text ?? page.label);
    const sections = [];
    const seen = new Map();
    const references = [];
    function localUrl(href, image = false) {
      if (/^(https?:|mailto:)/.test(href) || href.startsWith('#')) return href;
      const [filename, fragment] = href.split('#');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), filename));
      if (!existsSync(path.join(repository, target))) throw new Error(`${page.source}: missing link ${href}`);
      const destination = pageSources.find((candidate) => candidate.source === target);
      if (destination) return `${pagePath(destination.id, base)}${fragment ? `#${fragment}` : ''}`;
      if (image && target.startsWith('assets/')) return `${base}${target.slice("assets/".length)}`;
      return `https://github.com/RojhatToptamus/previewhost/blob/main/${target}${fragment ? `#${fragment}` : ''}`;
    }
    parser.use({ renderer: {
      heading({ depth, text, tokens }) {
        if (depth === 1) return '';
        const heading = plain(text);
        const initial = slug(heading);
        const count = seen.get(initial) ?? 0;
        seen.set(initial, count + 1);
        const id = `${initial}${count ? `-${count}` : ''}`;
        if (depth === 2) sections.push({ id, title: heading, summary: '', keywords: '' });
        return `<h${depth} id="${id}"><a class="docs-heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(heading)}">${this.parser.parseInline(tokens)}</a></h${depth}>`;
      },
      link({ href, tokens }) {
        const url = localUrl(href);
        references.push(url);
        return `<a class="docs-text-link" href="${escapeHtml(url)}">${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, text }) {
        const url = localUrl(href, true);
        const file = path.resolve(repository, path.dirname(page.source), href);
        const buffer = readFileSync(file);
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        references.push(url);
        return `<a href="${escapeHtml(url)}" aria-label="Open full size: ${escapeHtml(text)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(text)}" loading="lazy" width="${width}" height="${height}"></a>`;
      },
      codespan({ text }) { return `<code class="docs-inline-code">${escapeHtml(text)}</code>`; },
      code({ text, lang }) {
        return `<figure class="docs-code-block"><figcaption class="docs-code-toolbar"><span>${escapeHtml(lang || 'text')}</span><button class="docs-code-copy" type="button" data-copy-code aria-label="Copy code"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></figcaption><pre><code>${escapeHtml(text)}</code></pre></figure>`;
      },
      table(token) {
        const row = (cells, header) => `<tr>${cells.map((cell) => `<${header ? 'th scope="col"' : 'td'}>${this.parser.parseInline(cell.tokens)}</${header ? 'th' : 'td'}>`).join('')}</tr>`;
        return `<div class="docs-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(plain(token.header[0].text))} table"><table class="docs-table"><thead>${row(token.header, true)}</thead><tbody>${token.rows.map((cells) => row(cells, false)).join('')}</tbody></table></div>`;
      },
      blockquote({ tokens }) {
        return `<aside class="docs-callout docs-callout--info" role="note"><div class="docs-callout-copy">${this.parser.parse(tokens)}</div></aside>`;
      },
    } });
    // The first paragraph appears once, in the template's article header.
    const firstParagraph = tokens.findIndex((token) => token.type === 'paragraph');
    const body = tokens.filter((_, index) => index !== firstParagraph);
    let html = parser.parser(body);
    // Preserve the template's section spacing and borders for Markdown headings.
    const parts = html.split(/(?=<h2 id=)/);
    html = parts.map((part) => part.startsWith('<h2 ') ? `<section class="docs-section">${part}</section>` : part).join('');
    for (let i = 0; i < sections.length; i++) {
      const sectionHtml = parts.find((part) => part.startsWith(`<h2 id="${sections[i].id}"`)) ?? '';
      const text = plain(sectionHtml.replace(/<[^>]*>/g, ' '));
      sections[i].summary = text.slice(sections[i].title.length).trim().slice(0, 180);
      sections[i].keywords = text;
    }
    return { ...page, title, description, html, markdown, sections, references };
  });
}
