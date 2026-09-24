import { renderToString } from 'react-dom/server';
import { DocsApp } from './app';
import { pages, notFoundPage } from './pages';
import { LandingPage } from './landing';

export function render(id: string) {
  if (id === 'home') return renderToString(<LandingPage />);
  return renderToString(<DocsApp initialPageId={id} html={(pages.find((page) => page.id === id) ?? notFoundPage).html!} />);
}
