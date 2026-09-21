import { renderToString } from 'react-dom/server';
import { DocsApp } from './app';
import { pages, notFoundPage } from './pages';

export function render(id: string) {
  return renderToString(<DocsApp initialPageId={id} html={(pages.find((page) => page.id === id) ?? notFoundPage).html!} />);
}
