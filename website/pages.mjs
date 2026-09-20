// Each page has one Markdown source, also readable in the repository.
export const pageSources = [
  ['welcome', 'Introduction', 'Start', 'docs/introduction.md'],
  ['installation', 'Installation', 'Start', 'docs/installation.md'],
  ['first-preview', 'Your first preview', 'Start', 'docs/first-preview.md'],
  ['mcp', 'MCP setup', 'Start', 'docs/mcp.md'],
  ['configuration', 'Configuration', 'Guides', 'docs/recipes.md'],
  ['services-and-jobs', 'Services and jobs', 'Guides', 'docs/jobs.md'],
  ['databases', 'Databases', 'Guides', 'docs/databases.md'],
  ['secrets', 'Secrets', 'Guides', 'docs/secrets.md'],
  ['worktrees', 'Worktrees', 'Guides', 'docs/worktrees.md'],
  ['dashboard', 'Dashboard', 'Guides', 'docs/dashboard.md'],
  ['troubleshooting', 'Troubleshooting', 'Help', 'docs/troubleshooting.md'],
  ['reference', 'API and CLI', 'Reference', 'docs/api.md'],
  ['library', 'Node.js library', 'Reference', 'docs/library.md'],
  ['integrations', 'Integrations', 'Reference', 'docs/integrations.md'],
  ['security', 'Security and limits', 'Reference', 'docs/security.md'],
].map(([id, label, group, source]) => ({ id, label, group, source }));

export function pagePath(id, base = '/') {
  return `${base}${id === 'welcome' ? '' : `${id}/`}`;
}
