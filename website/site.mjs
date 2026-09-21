export function siteSettings(env = process.env) {
  const url = env.DOCS_URL ? new URL(env.DOCS_URL) : undefined;
  if (url && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)) {
    throw new Error('DOCS_URL must be an HTTPS URL without credentials, a query, or a fragment.');
  }
  if (url && !url.pathname.endsWith('/')) url.pathname += '/';
  const base = env.DOCS_BASE || url?.pathname || '/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) {
    throw new Error('DOCS_BASE must be an absolute URL path with a trailing slash.');
  }
  if (url && url.pathname !== base) throw new Error('DOCS_BASE must match the path in DOCS_URL.');
  return { base, url };
}
