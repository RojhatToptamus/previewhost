import type { LogResult, PreviewDescription, PreviewStatus, SecretSetupSummary } from './contracts.js';

export const dashboardPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Previews · Previewhost</title><link rel="stylesheet" href="/dashboard.css"></head>
<body><header><span class="brand">previewhost<span class="local">LOCAL</span></span><span id="connection">Connecting…</span></header>
<div id="notice" role="status" hidden></div>
<main><aside><div class="list-heading"><h1>Previews</h1><button id="refresh" aria-label="Refresh previews">↻</button></div>
<label class="search"><span class="sr-only">Search projects and previews</span><input id="search" placeholder="Find a project or preview" type="search"></label>
<nav id="projects" aria-label="Projects and previews"></nav>
<p class="scope">Known local owners only. Closing this page leaves previews running.</p></aside>
<article id="detail" aria-label="Preview details"><p class="muted">Connecting to local previews…</p></article></main>
<script src="/dashboard.js"></script></body></html>`;

function mountDashboard() {
  type Owner = { id: string; project?: string; previews?: PreviewStatus[]; requests?: SecretSetupSummary[]; legacy?: boolean; error?: { message: string } };
  let capability = location.hash.slice(1);
  history.replaceState(null, '', '/');
  const sessionKey = 'previewhost-dashboard';
  try {
    if (capability) sessionStorage.setItem(sessionKey, capability);
    else capability = sessionStorage.getItem(sessionKey) ?? '';
  } catch { /* A fresh launcher session still works when browser storage is unavailable. */ }
  let owners: Owner[] = [];
  let selection: { owner: string; name?: string } | undefined;
  let snapshot = '';
  let loading = false;
  let acting = false;
  let connectionNotice = false;
  let expanded: { key: string; logs?: LogResult; description?: PreviewDescription } | undefined;
  const projects = document.querySelector<HTMLElement>('#projects')!;
  const detail = document.querySelector<HTMLElement>('#detail')!;
  const search = document.querySelector<HTMLInputElement>('#search')!;
  const notice = document.querySelector<HTMLElement>('#notice')!;
  const connection = document.querySelector<HTMLElement>('#connection')!;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  }
  function announce(message: string, disconnected = false) { notice.textContent = message; notice.hidden = !message; connectionNotice = disconnected; }
  function button(label: string, action: () => void, className = '', key = label) {
    const node = el('button', label, className);
    node.type = 'button'; node.dataset.focus = key; node.disabled = acting;
    node.addEventListener('click', action);
    return node;
  }
  async function call<T>(body: object): Promise<T> {
    const response = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + capability }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error?.code === 'NOT_FOUND' && data.error.message === 'Unknown control operation.' && 'action' in body && body.action === 'saveConfiguration') {
      throw new Error('This owner does not support configuration saving. Ask your agent to save preview.yml, or upgrade the owner when you are ready to stop its previews.');
    }
    if (data.error) throw new Error(data.error.code === 'STALE_ATTEMPT' ? 'This preview changed. Review its current state and try again.' : data.error.message);
    return data.result;
  }
  function needsCleanup(preview: PreviewStatus) {
    return !!(preview.cleanup?.length || preview.data?.cleanup ||
      [preview.active, preview.candidate, preview.latest].some(attempt => attempt?.state === 'cleanup-incomplete'));
  }
  function state(preview: PreviewStatus): { label: string; tone: string } {
    if (needsCleanup(preview)) return { label: 'Cleanup needs attention', tone: 'warning' };
    if (preview.active) {
      if (preview.candidate) return { label: 'Preview available · updating', tone: 'working' };
      if (preview.busy) return { label: 'Operation in progress', tone: 'working' };
      if (preview.latest && preview.latest.id !== preview.active.id && ['failed', 'canceled'].includes(preview.latest.state)) return { label: 'Preview available · update ' + preview.latest.state, tone: preview.latest.state === 'failed' ? 'warning' : 'muted' };
      return { label: 'Ready', tone: 'ready' };
    }
    if (preview.candidate) return { label: 'Starting', tone: 'working' };
    if (preview.busy) return { label: 'Operation in progress', tone: 'working' };
    if (preview.latest?.state === 'failed') return { label: 'Startup failed', tone: 'warning' };
    if (preview.latest?.state === 'canceled') return { label: 'Startup canceled', tone: 'muted' };
    return { label: preview.data ? 'Stopped · data retained' : 'Stopped', tone: 'muted' };
  }
  function shortProject(owner: Owner) { return owner.project?.split('/').filter(Boolean).at(-1) ?? 'Unavailable owner'; }
  function select(owner: Owner, name?: string) {
    announce(''); selection = { owner: owner.id, name }; expanded = undefined;
    document.body.classList.add('show-detail'); render();
    const heading = detail.querySelector('h2');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
  function renderList() {
    projects.replaceChildren();
    const query = search.value.toLowerCase();
    let count = 0;
    for (const owner of owners) {
      const previews = owner.previews?.filter(p => `${owner.project} ${p.name}`.toLowerCase().includes(query)) ?? [];
      if (!previews.length && query && !`${owner.project}`.toLowerCase().includes(query)) continue;
      count++;
      const group = el('section', '', 'project');
      const projectButton = button(shortProject(owner), () => select(owner), 'project-title', owner.id);
      projectButton.disabled = false;
      group.append(projectButton, el('p', owner.project ?? 'Record could not be verified', 'path'));
      const pending = owner.requests?.filter(r => r.state === 'pending' || r.state === 'saving').length ?? 0;
      if (pending) group.append(button(`${pending} private setup ${pending === 1 ? 'request' : 'requests'}`, () => select(owner), 'private-link', owner.id + '-private'));
      if (owner.error) group.append(el('p', 'Status unavailable', 'warning'));
      for (const preview of previews) {
        const status = state(preview);
        const row = button('', () => select(owner, preview.name), 'preview-row', owner.id + preview.name);
        row.disabled = false;
        const chosen = selection?.owner === owner.id && selection.name === preview.name;
        row.setAttribute('aria-current', chosen ? 'true' : 'false');
        row.append(el('strong', preview.name), el('span', status.label, 'status ' + status.tone));
        group.append(row);
      }
      if (!owner.error && !owner.previews?.length && !pending) group.append(el('p', 'No previews in this project', 'muted'));
      projects.append(group);
    }
    if (!count) projects.append(el('p', query ? 'No matching previews.' : 'No previews found.', 'empty-list'));
  }
  function urlLink(url: string, label: string, primary = false) {
    const link = el('a', label, primary ? 'button primary' : 'endpoint');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' || !(parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.localhost'))) throw new Error();
      link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    } catch { link.removeAttribute('href'); }
    return link;
  }
  function section(title: string, text?: string, parent = detail) {
    const node = el('section', '', 'section'); node.append(el('h3', title));
    if (text) node.append(el('p', text, 'muted'));
    parent.append(node); return node;
  }
  async function mutate<T = unknown>(body: object, message: string | ((result: T) => string)) {
    acting = true; announce('Working…'); render();
    try { const result = await call<T>(body); announce(typeof message === 'function' ? message(result) : message); }
    catch (error) { announce(error instanceof Error ? error.message : 'The action failed. Check current status before retrying.'); }
    finally { acting = false; snapshot = ''; await refresh(); render(); }
  }
  function renderRequests(owner: Owner, parent = detail) {
    if (!owner.requests?.length) return;
    const node = section('Private setup', 'Approval and values stay in the private form. Saving does not start the application.', parent);
    for (const request of owner.requests) {
      const row = el('div', '', 'request');
      const labels = { pending: 'Needs your attention', saving: 'Saving…', complete: 'Complete', partial: 'Partly saved', canceled: 'Canceled', expired: 'Expired' };
      row.append(el('strong', request.name ?? 'Secret edit'), el('span', labels[request.state], 'status'));
      if (request.state === 'pending') {
        row.append(button('Open private form', () => { void mutate({ action: 'secretsOpen', owner: owner.id, id: request.id }, 'Private form requested in your system browser.'); }, '', request.id));
        if (request.browser === 'failed') row.append(el('p', 'The browser did not open. Try opening the private form again.', 'warning'));
      } else if (request.state === 'complete') row.append(el('p', 'If your agent ended its turn, send “Secrets saved—continue” in that chat.', 'muted'));
      else if (request.state === 'canceled') row.append(el('p', 'Setup stopped. Ask your agent for a new request only when you want to continue.', 'muted'));
      else if (request.state === 'expired' || request.state === 'partial') row.append(el('p', 'Ask your agent to check setup and request any remaining values.', 'muted'));
      node.append(row);
    }
  }
  function renderDetail() {
    detail.replaceChildren();
    const back = button('← Previews', () => {
      document.body.classList.remove('show-detail');
      const key = selection ? selection.owner + (selection.name ?? '') : '';
      projects.querySelector<HTMLElement>('[data-focus="' + CSS.escape(key) + '"]')?.focus();
    }, 'back');
    back.disabled = false; detail.append(back);
    const owner = owners.find(owner => owner.id === selection?.owner);
    if (!owner) {
      if (selection) { section('Project no longer listed', 'Its owner may have shut down. Stored database data remains separate; start through your agent or CLI to reconnect.'); return; }
      detail.append(el('div', 'Your applications, in one place.', 'empty-title'), el('p', 'Start an application with Previewhost through your agent or terminal. Its project will appear here.', 'muted'),
        el('p', 'This page lists known owners. Projects and retained data from an owner that shut down are not a permanent catalog.', 'muted'));
      return;
    }
    const preview = owner.previews?.find(p => p.name === selection?.name);
    detail.append(el('p', shortProject(owner), 'eyebrow'), el('h2', preview?.name ?? 'Project'), el('p', owner.project ?? 'Unverified project record', 'path full-path'));
    if (owner.error) {
      section('Status unavailable', 'Your previews may still be running. Keep their sources and verify cleanup through the project CLI.').append(el('p', owner.error.message, 'error-text')); return;
    }
    if (owner.legacy) section('Owner update needed', 'This owner runs an older build. Private requests and Start again are unavailable. Upgrade it explicitly when you are ready to stop its previews; this page will not restart it.');
    if (!preview) { renderRequests(owner); if (!owner.requests?.length) section('No previews', 'Ask your agent to start an application in this project.'); return; }
    const status = state(preview);
    const actions = el('div', '', 'actions');
    detail.append(el('p', status.label, 'headline-status ' + status.tone), actions);
    const primaryService = Object.values(preview.active?.services ?? {}).find(s => s.browserUrl);
    const primaryUrl = preview.url;
    if (preview.active && primaryUrl) actions.append(urlLink(primaryUrl, 'Open preview', true));
    if (preview.candidate) actions.append(button(preview.active ? 'Cancel update' : 'Cancel startup', () => { void mutate({ action: 'cancel', owner: owner.id, name: preview.name, attemptId: preview.candidate!.id }, 'The selected attempt was canceled.'); }));
    if ((preview.active || needsCleanup(preview) || preview.url) && !preview.busy) {
      if (!owner.legacy) actions.append(button(needsCleanup(preview) ? 'Retry cleanup' : 'Stop preview', () => { void mutate({ action: 'stop', owner: owner.id, name: preview.name,
        expected: { active: preview.active?.id ?? null, candidate: preview.candidate?.id ?? null, latest: preview.latest?.id ?? null } }, 'Preview stopped. Managed database data stays.'); }));
      else section('Stop through the CLI', 'This older owner cannot validate a stale dashboard action. Run this command from the project directory shown above.').append(el('pre', 'previewhost stop ' + preview.name));
    }
    if (!preview.active && !preview.busy && !preview.candidate && ['stopped', 'failed'].includes(preview.latest?.state ?? '') && !owner.legacy && !needsCleanup(preview)) {
      const retry = preview.latest?.state === 'failed';
      actions.append(button(retry ? 'Retry start' : 'Start again', () => { void mutate({ action: 'startAgain', owner: owner.id, name: preview.name, attemptId: preview.latest!.id }, 'Starting again with the same configuration and current source.'); }, 'primary'));
      if (retry) detail.append(el('p', 'Resolve the startup error before retrying.', 'muted'));
      detail.append(el('p', 'Runs the same configuration against current source. Does not reload preview.yml. The URL may change.', 'muted'));
    } else if (!preview.active && !preview.candidate && !preview.busy && !needsCleanup(preview)) {
      detail.append(el('p', `Ask your agent to start “${preview.name}” again in ${owner.project}.`, 'muted'));
    }
    if (preview.active) detail.append(el('p', 'Ready means startup checks passed. Stop keeps managed database data.', 'muted'));
    if (owner.requests?.some(r => (r.state === 'pending' || r.state === 'saving') && r.name === preview.name)) renderRequests({ ...owner, requests: owner.requests.filter(r => r.name === preview.name && ['pending', 'saving'].includes(r.state)) });
    if (primaryUrl) {
      const routes = section('Application links');
      routes.append(urlLink(primaryUrl, primaryUrl), button('Copy URL', () => { void navigator.clipboard.writeText(primaryUrl).then(() => announce('URL copied.'), () => announce('Copy the application link above.')); }));
      if (primaryService?.browserUrl) routes.append(el('p', 'Service hostname links are listed below.', 'muted'));
    }
    const attempts = [preview.candidate, preview.latest?.id !== preview.active?.id ? preview.latest : undefined, preview.active, preview.latest].filter((a, i, all) => a && all.findIndex(other => other?.id === a.id) === i);
    for (const attempt of attempts) {
      if (!attempt) continue;
      const title = attempt.id === preview.active?.id ? 'Serving application' : attempt.id === preview.candidate?.id ? (preview.active ? 'Update in progress' : 'Starting attempt') : preview.active ? 'Latest update' : 'Last attempt';
      const node = section(title);
      node.append(el('p', attempt.state, 'status'));
      if (attempt.error) node.append(el('p', attempt.error.message, 'error-text'));
      for (const [name, service] of Object.entries(attempt.services ?? {})) {
        const row = el('div', '', 'service'); row.append(el('strong', name), el('span', service.type, 'muted'), el('span', service.state, 'status'));
        if (attempt.id === preview.active?.id && service.browserUrl) row.append(urlLink(service.browserUrl, 'Open service ↗'));
        if (service.error) row.append(el('p', service.error.message, 'error-text'));
        node.append(row);
      }
      for (const source of attempt.sources) node.append(el('p', source, 'path'));
      const key = owner.id + '/' + preview.name + '/' + attempt.id;
      const load = async (action: 'logs' | 'describe') => {
        try {
          const result = await call<LogResult | PreviewDescription>({ action, owner: owner.id, name: preview.name, attemptId: attempt.id });
          if (selection?.owner !== owner.id || selection?.name !== preview.name) return;
          expanded = { ...(expanded?.key === key ? expanded : { key }), [action === 'logs' ? 'logs' : 'description']: result };
          render();
        } catch (error) { announce(error instanceof Error ? error.message : 'Details unavailable.'); }
      };
      const controls = el('div', '', 'actions');
      controls.append(button('Show logs', () => { void load('logs'); }, '', key + '-logs'));
      if (!owner.legacy) controls.append(button('Configuration', () => { void load('describe'); }, '', key + '-config'));
      node.append(controls);
      if (expanded?.key === key) {
        if (expanded.logs) node.append(el('p', expanded.logs.truncated ? 'Log tail · earlier output omitted' : 'Log tail', 'muted'), el('pre', expanded.logs.text || 'No output captured.', 'logs'));
        if (expanded.description) {
          const description = expanded.description;
          node.append(el('p', 'Requested configuration · values omitted', 'muted'));
          if (description.envKeys.length) node.append(el('p', 'Environment variables: ' + description.envKeys.join(', ')));
          for (const secret of description.secrets ?? []) {
            node.append(el('p', secret.bindings.map(binding => (binding.service ? binding.service + '.' : '') + binding.key).join(', ') + ' → stored reference ' + secret.id + (secret.selected ? ' · access approved for this owner' : ' · approval required')));
          }
          const configuration = el('details');
          configuration.append(el('summary', 'Service configuration'), el('pre', JSON.stringify(description.spec, null, 2), 'configuration'));
          node.append(configuration);
          node.append(el('p', 'Save this attempt as a new project recipe. Existing files are not overwritten, and the running preview is unchanged.', 'muted'),
            button('Save as preview.yml', () => {
              void mutate<{ file: string; externalSources: string[] }>({ action: 'saveConfiguration', owner: owner.id, name: preview.name, attemptId: attempt.id }, result =>
                `Saved ${result.file}. The running preview is unchanged.` + (result.externalSources.length ?
                  ' Sources outside this project keep absolute paths: ' + result.externalSources.join(', ') : ''));
            }, '', key + '-save'));
        }
      }
    }
    if (preview.cleanup?.length) {
      const cleanup = section('Cleanup needs attention', 'Keep these source directories until cleanup succeeds.');
      for (const item of preview.cleanup) cleanup.append(el('p', item.error.message, 'error-text'), ...item.sources.map(source => el('p', source, 'path')));
    }
    if (owner.requests?.some(r => r.name === preview.name && !['pending', 'saving'].includes(r.state))) {
      const history = el('details', '', 'section'); history.append(el('summary', 'Private setup history')); detail.append(history);
      renderRequests({ ...owner, requests: owner.requests.filter(r => r.name === preview.name && !['pending', 'saving'].includes(r.state)) }, history);
    }
    if (preview.data) {
      const node = section('Managed data', 'Stop retains this data. Deletion is a separate explicit CLI operation.');
      for (const resource of preview.data.resources) node.append(el('p', `${resource.name} · ${resource.type} · ${preview.data.running ? 'running' : 'retained'}`));
      if (preview.data.cleanup) node.append(el('p', preview.data.cleanup.message, 'error-text'));
    }
  }
  function render() {
    const focus = (document.activeElement as HTMLElement)?.dataset.focus;
    renderList(); renderDetail();
    if (focus) document.querySelector<HTMLElement>('[data-focus="' + CSS.escape(focus) + '"]')?.focus({ preventScroll: true });
  }
  async function refresh() {
    if (loading || document.hidden) return;
    loading = true;
    try {
      const result = await call<Owner[]>({ action: 'list' });
      connection.textContent = 'Connected · local only';
      if (connectionNotice) announce('');
      const next = JSON.stringify(result);
      if (next !== snapshot) {
        owners = result; snapshot = next;
        if (!selection && owners.length) selection = { owner: owners[0].id, name: owners[0].previews?.[0]?.name };
        render();
      }
    } catch (error) {
      connection.textContent = 'Disconnected';
      announce(capability ? 'Dashboard disconnected. Your previews may still be running. Run previewhost dashboard to reopen it.' : 'Run previewhost dashboard to open an authenticated session. This tab has no usable private session.', true);
      if (!capability) document.body.classList.add('show-detail');
      if (!capability) detail.replaceChildren(el('h2', 'Open from your terminal'), el('pre', 'previewhost dashboard'), el('p', 'The launcher opens a private local session. No account is needed.', 'muted'));
      else if (error instanceof Error && error.message.includes('too large')) announce(error.message);
    } finally { loading = false; }
  }
  search.addEventListener('input', renderList);
  document.querySelector('#refresh')!.addEventListener('click', () => { snapshot = ''; void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh();
  setInterval(() => { if (capability) void refresh(); }, 2500);
}

export const dashboardScript = `(${mountDashboard.toString()})();`;
export const dashboardStyle = `
:root {
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color:#243331;
  background:#fafbf9;
  font-size:14px;
  color-scheme:light;
}
* {
  box-sizing:border-box;
}
body {
  margin:0;
}
button,input {
  font:inherit;
}
button,.button {
  border:1px solid #d7dfda;
  border-radius:6px;
  background:#fff;
  color:#243331;
  padding:9px 13px;
  cursor:pointer;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  transition:background .12s,border-color .12s;
}
button:hover,.button:hover {
  background:#edf2ef;
  border-color:#a5b9af;
}
button:disabled {
  opacity:.5;
  cursor:wait;
}
a {
  color:#176a51;
}
a:hover {
  text-decoration:underline;
}
:focus-visible {
  outline:3px solid #4d9e80;
  outline-offset:3px;
}
.primary {
  background:#216c53;
  color:white;
  border-color:#216c53;
}
.primary:hover {
  background:#17523e;
  color:white;
}
header {
  height:68px;
  border-bottom:1px solid #dde4de;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:0 30px;
  background:#fff;
}
.brand {
  font-weight:750;
  letter-spacing:-.7px;
  font-size:21px;
  text-decoration:none;
  color:#243331;
  display:flex;
  align-items:center;
  gap:14px;
}
.local {
  letter-spacing:1.3px;
  font-size:10px;
  color:#71837a;
  font-weight:600;
}
#connection {
  font-size:12px;
  color:#687970;
}
main {
  display:grid;
  grid-template-columns:300px minmax(0,1fr);
  min-height:calc(100vh - 68px);
}
aside {
  padding:26px 20px;
  border-right:1px solid #dde4de;
  background:#f1f4ef;
}
.list-heading {
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:20px;
}
h1 {
  font-size:23px;
  letter-spacing:-.6px;
  margin:0;
}
#refresh {
  font-size:22px;
  padding:3px 10px;
  background:transparent;
  border-color:transparent;
}
.search input {
  width:100%;
  background:#fff;
  border:1px solid #d6ded8;
  border-radius:6px;
  padding:11px 12px;
  margin-bottom:28px;
}
.project {
  margin:0 0 24px;
}
.project-title {
  border:0;
  background:transparent;
  padding:0;
  font-weight:700;
  justify-content:flex-start;
  text-align:left;
}
.project .path {
  font-size:11px;
  margin:7px 0 12px;
}
.path {
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  color:#718078;
  overflow-wrap:anywhere;
  line-height:1.6;
}
.preview-row {
  width:100%;
  border:0;
  background:transparent;
  display:flex;
  align-items:flex-start;
  flex-direction:column;
  gap:7px;
  text-align:left;
  padding:13px 12px;
  margin:4px 0;
}
.preview-row[aria-current=true] {
  background:#fff;
  box-shadow:inset 3px 0 #216c53;
}
.status {
  font-size:12px;
}
.ready {
  color:#216c53;
}
.warning,.error-text {
  color:#985222;
}
.working {
  color:#526d94;
}
.muted,.scope {
  color:#6c7b72;
  line-height:1.65;
}
.scope {
  font-size:12px;
  margin-top:38px;
  max-width:240px;
}
.private-link {
  font-size:12px;
  border:0;
  padding:7px 0;
  background:transparent;
  color:#985222;
}
article {
  padding:42px 48px 64px;
  max-width:1100px;
  width:100%;
  min-width:0;
}
.eyebrow {
  text-transform:uppercase;
  letter-spacing:1.3px;
  font-size:11px;
  font-weight:650;
  color:#718078;
  margin:0 0 8px;
}
h2 {
  font-size:34px;
  letter-spacing:-1px;
  font-weight:650;
  margin:0 0 12px;
}
h3 {
  font-size:15px;
  margin:0 0 12px;
  font-weight:650;
}
.full-path {
  margin-bottom:22px;
  font-size:12px;
}
.headline-status {
  font-size:15px;
  font-weight:600;
  margin:26px 0 18px;
}
.actions {
  display:flex;
  flex-wrap:wrap;
  gap:9px;
  margin:14px 0;
}
.section {
  border-top:1px solid #e0e6df;
  padding-top:24px;
  margin-top:28px;
}
.section p {
  margin:9px 0;
}
.service {
  display:flex;
  gap:18px;
  align-items:center;
  padding:13px 0;
  border-bottom:1px solid #edf0ea;
  flex-wrap:wrap;
}
.service strong {
  min-width:90px;
}
.service .status {
  margin-left:auto;
}
.service .error-text {
  flex-basis:100%;
}
.service a {
  font-size:12px;
}
.endpoint {
  display:inline-block;
  overflow-wrap:anywhere;
  margin:7px 15px 7px 0;
  font-family:ui-monospace,monospace;
  font-size:12px;
}
.request {
  padding:15px 0;
  border-bottom:1px solid #e0e6df;
  display:flex;
  gap:14px;
  align-items:center;
  flex-wrap:wrap;
}
.request p {
  flex-basis:100%;
  font-size:12px;
}
.request button {
  margin-left:auto;
}
pre {
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  max-height:380px;
  overflow:auto;
  background:#edf1ec;
  border-radius:6px;
  padding:18px;
  font-size:12px;
  line-height:1.65;
}
.logs {
  background:#22342c;
  color:#e6eee7;
}
.error-text {
  line-height:1.6;
  overflow-wrap:anywhere;
}
.empty-title {
  font-size:27px;
  letter-spacing:-.7px;
  margin-top:60px;
}
.empty-list {
  padding:10px 0;
  color:#718078;
}
#notice {
  padding:13px 30px;
  background:#fff4d8;
  border-bottom:1px solid #ebdcae;
  line-height:1.5;
}
.back {
  display:none;
}
.sr-only {
  position:absolute;
  width:1px;
  height:1px;
  overflow:hidden;
  clip:rect(0,0,0,0);
}
@media(max-width:760px) {
  header {
    padding:0 18px;
    height:60px;
  }
  .brand {
    font-size:19px;
  }
  #connection {
    font-size:10px;
  }
  main {
    display:block;
  }
  aside {
    border-right:0;
    min-height:calc(100vh - 60px);
    padding:24px;
  }
  article {
    display:none;
    padding:25px 24px 50px;
  }
  .show-detail aside {
    display:none;
  }
  .show-detail article {
    display:block;
  }
  .back {
    display:inline-flex;
    margin-bottom:30px;
  }
  .full-path {
    font-size:11px;
  }
  h2 {
    font-size:29px;
  }
  .service {
    gap:10px;
  }
  .request button {
    margin-left:0;
  }
  #notice {
    padding:12px 18px;
  }
}
@media(prefers-reduced-motion:reduce) {
  * {
    transition:none!important;
  }
}
`;
