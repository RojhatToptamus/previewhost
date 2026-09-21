import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadPages, repository } from './content.mjs';
import { resolve } from 'node:path';
import { siteSettings } from './site.mjs';

const { base } = siteSettings();

export default defineConfig(({ isPreview }) => ({
  appType: isPreview ? 'mpa' : 'spa',
  root: resolve(repository, 'website'),
  publicDir: resolve(repository, 'assets'),
  base,
  plugins: [react(), {
    name: 'documentation-content',
    resolveId(id) { if (id === 'virtual:docs') return '\0virtual:docs'; },
    load(id) {
      if (id !== '\0virtual:docs') return;
      const pages = loadPages(base);
      for (const page of pages) this.addWatchFile(resolve(repository, page.source));
      const metadata = pages.map(({ html, markdown, publishedMarkdown, references, source, ...page }) => page);
      const rendered = pages.map(({ markdown, publishedMarkdown, references, source, ...page }) => page);
      return `export default (import.meta.env.SSR || import.meta.env.DEV) ? ${JSON.stringify(rendered)} : ${JSON.stringify(metadata)};`;
    },
    handleHotUpdate({ file, server }) {
      if (!file.endsWith('.md')) return;
      const module = server.moduleGraph.getModuleById('\0virtual:docs');
      if (module) server.moduleGraph.invalidateModule(module);
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  }],
  build: { outDir: resolve(repository, '.local/docs-site'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4173 },
  preview: { host: '127.0.0.1', port: 4173 },
}));
