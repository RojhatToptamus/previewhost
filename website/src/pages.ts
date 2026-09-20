import content from 'virtual:docs';

export type DocPageId = string;
export type DocPage = {
  id: DocPageId;
  label: string;
  title: string;
  description: string;
  group: string;
  html?: string;
  sections: Array<{ id: string; title: string; summary: string; keywords: string }>;
};
export const pages: DocPage[] = content;
export const notFoundPage: DocPage = {
  id: 'not-found', label: 'Page not found', title: 'Page not found',
  description: 'This address does not match a documentation page.', group: 'Help', sections: [],
  html: `<p><a class="docs-text-link" href="${import.meta.env.BASE_URL}">Read the Previewhost introduction</a>, or choose a guide from the navigation.</p>`,
};
export function pageHref(id: string, section?: string) {
  return `${import.meta.env.BASE_URL}${id === 'welcome' ? '' : `${id}/`}${section ? `#${section}` : ''}`;
}
export function pageFromLocation() {
  const path = window.location.pathname.replace(import.meta.env.BASE_URL, '').replace(/\/$/, '');
  if (!path || path === 'index.html') return 'welcome';
  return pages.find((page) => page.id === path)?.id ?? 'not-found';
}
