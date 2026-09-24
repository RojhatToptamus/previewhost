import { createRoot, hydrateRoot } from 'react-dom/client';
import { DocsApp } from './app';
import { pageFromLocation, pages, notFoundPage } from './pages';
import { initializeSiteTheme } from './siteTheme';
import { LandingPage } from './landing';

initializeSiteTheme();
const element = document.getElementById('root')!;
const initialPageId = pageFromLocation();
const html = element.querySelector('.docs-article-body')?.innerHTML ?? pages.find((page) => page.id === initialPageId)?.html ?? notFoundPage.html!;
const app = initialPageId === 'home' ? <LandingPage /> : <DocsApp initialPageId={initialPageId} html={html} />;
const root = element.hasChildNodes() ? hydrateRoot(element, app) : createRoot(element);
if (!element.hasChildNodes()) root.render(app);
import.meta.hot?.dispose(() => root.unmount());
