// Each page has one Markdown source, also readable in the repository.
export const pageSources = [
  ['welcome', 'Introduction', 'Start', 'docs/introduction.md'],
  ['installation', 'Installation', 'Start', 'docs/installation.md'],
  ['first-preview', 'CLI quickstart', 'Start', 'docs/first-preview.md'],
  ['mcp', 'MCP setup', 'Start', 'docs/mcp.md'],
  ['library', 'Node.js library', 'Start', 'docs/library.md'],
  ['configuration', 'Write preview.yaml', 'Guides', 'docs/recipes.md'],
  ['services-and-jobs', 'Services and jobs', 'Guides', 'docs/jobs.md'],
  ['databases', 'Databases', 'Guides', 'docs/databases.md'],
  ['secrets', 'Secrets', 'Guides', 'docs/secrets.md'],
  ['worktrees', 'Worktrees', 'Guides', 'docs/worktrees.md'],
  ['dashboard', 'Dashboard', 'Guides', 'docs/dashboard.md'],
  ['troubleshooting', 'Troubleshooting', 'Help', 'docs/troubleshooting.md'],
  ['reference', 'API and CLI', 'Reference', 'docs/api.md'],
  ['integrations', 'Integrations', 'Reference', 'docs/integrations.md'],
  ['security', 'Security and limits', 'Reference', 'docs/security.md'],
].map(([id, label, group, source]) => ({ id, label, group, source }));

export function pagePath(id, base = '/') {
  return `${base}${id === 'home' ? '' : id === 'welcome' ? 'introduction/' : `${id}/`}`;
}

export const homePage = {
  id: 'home',
  title: 'Your whole app. One local preview.',
  documentTitle: 'Previewhost — Your whole app. One local preview.',
  description: 'Run your frontend, APIs, and databases together on your machine. Separate previews for every worktree, with a stable local URL when you replace a running preview.',
};
