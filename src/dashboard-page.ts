import { uiStyle, themeScript } from './ui.js';
import type { AttemptSummary, LogResult, PreviewDescription, PreviewStatus, SecretSetupSummary } from './contracts.js';

export const dashboardPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Previews · Previewhost</title><link rel="stylesheet" href="/dashboard.css"></head>
<body><header><button id="home" class="brand">previewhost</button><span class="slash">/</span><span id="crumb">All previews</span>
<span id="connection">Connecting…</span><button id="theme" aria-label="Switch to dark theme">Dark</button><button id="refresh">Refresh</button></header>
<div id="notice" role="status" hidden></div>
<div class="workspace"><aside><label class="search"><span class="sr-only">Search projects and previews</span><input id="search" placeholder="Search" type="search"></label>
<button id="overview" class="nav-overview">All previews<span id="attention-count"></span></button>
<nav id="projects" aria-label="Projects and previews"></nav><p class="scope">Closing this window leaves previews running.</p></aside>
<main id="main"><article id="detail" aria-label="Preview details"><p class="muted">Connecting to local previews…</p></article></main></div>
<script src="/dashboard.js"></script></body></html>`;

function mountDashboard() {
  type Owner = { id: string; project?: string; previews?: PreviewStatus[]; requests?: SecretSetupSummary[]; legacy?: boolean; configuration?: { file: string; error?: { message: string } }; error?: { message: string } };
  type Entry = { owner: Owner; name?: string; preview?: PreviewStatus };
  type Action = { label: string; run: () => void; danger?: boolean };
  type Tab = 'activity' | 'logs' | 'configuration';
  let capability = location.hash.slice(1);
  history.replaceState(null, '', '/');
  try {
    if (capability) sessionStorage.setItem('previewhost-dashboard', capability);
    else capability = sessionStorage.getItem('previewhost-dashboard') ?? '';
  } catch { /* Initial launch still works when browser storage is unavailable. */ }
  let owners: Owner[] = [];
  let selection: { owner: string; name?: string } | undefined;
  let snapshot = '';
  let loading = false;
  let acting = false;
  let connectionNotice = false;
  let panel: { tab: Tab; attemptId?: string; loading?: boolean; error?: string; logs?: LogResult; description?: PreviewDescription } = { tab: 'activity' };
  const projects = document.querySelector<HTMLElement>('#projects')!;
  const detail = document.querySelector<HTMLElement>('#detail')!;
  const search = document.querySelector<HTMLInputElement>('#search')!;
  const notice = document.querySelector<HTMLElement>('#notice')!;
  const connection = document.querySelector<HTMLElement>('#connection')!;
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  }
  function announce(message: string, disconnected = false) { notice.textContent = message; notice.hidden = !message; connectionNotice = disconnected; }
  function button(label: string, action: () => void, className = '', key = label) {
    const node = el('button', label, className);
    node.type = 'button'; node.dataset.focus = key; node.disabled = acting; node.addEventListener('click', action); return node;
  }
  function navButton(label: string, action: () => void, className = '', key = label) {
    const node = button(label, action, className, key); node.disabled = false; return node;
  }
  function copy(value: string, label = 'Copy') {
    const node = button(label, () => {
      void navigator.clipboard.writeText(value).then(() => {
        node.textContent = 'Copied'; setTimeout(() => { node.textContent = label; }, 1400);
      }, () => announce('Copy was unavailable. Select and copy the text instead.'));
    }, 'small', 'copy-' + value);
    return node;
  }
  function pathText(path: string) {
    const node = el('span', '', 'path'); node.title = path;
    const parts = path.split('/'); const tail = parts.splice(-2).join('/');
    node.append(el('span', parts.length ? parts.join('/') + '/' : '', 'path-parent'), el('span', tail, 'path-tail'));
    return node;
  }
  function pathBar(path: string) {
    const node = el('div', '', 'path-bar'); node.append(pathText(path), copy(path)); return node;
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
  function needsCleanup(preview?: PreviewStatus) {
    return !!(preview?.cleanup?.length || preview?.data?.cleanup ||
      [preview?.active, preview?.candidate, preview?.latest].some(attempt => attempt?.state === 'cleanup-incomplete'));
  }
  function requests(entry: Entry) { return entry.owner.requests?.filter(r => r.name === entry.name) ?? []; }
  function pending(entry: Entry) { return requests(entry).filter(r => r.state === 'pending' || r.state === 'saving'); }
  function state(entry: Entry) {
    const p = entry.preview;
    if (needsCleanup(p)) return { label: 'Cleanup incomplete', tone: 'error', note: 'Cleanup needs attention' };
    if (pending(entry).length) return { label: 'Needs secrets', tone: 'warning', note: p?.active ? 'App still serving' : 'Private setup requested' };
    if (p?.candidate || p?.busy) return { label: 'Starting', tone: 'neutral', note: p.active ? 'Previous attempt serving' : p.busy ? 'Operation in progress' : 'Startup checks in progress' };
    if (p?.latest?.state === 'failed') return { label: p.active ? 'Update failed' : 'Startup failed', tone: 'error', note: p.active ? 'Previous attempt serving' : 'Startup failed · not serving' };
    if (!p && entry.owner.configuration?.error) return { label: 'Configuration error', tone: 'error', note: 'Fix preview.yml before startup' };
    if (!p) return { label: 'Not started', tone: 'muted', note: requests(entry).some(r => r.state === 'canceled') ? 'Private setup canceled' : 'No preview started' };
    if (p?.active) return { label: 'Ready', tone: 'ready', note: entry.owner.configuration?.error ? 'preview.yml needs attention · app serving' : p.latest?.state === 'canceled' ? 'Update canceled · app serving' : 'Startup checks passed' };
    return { label: 'Stopped', tone: 'muted', note: p?.latest?.state === 'canceled' ? 'Startup canceled' : p?.data ? 'Data retained' : 'Not running' };
  }
  function shortProject(owner: Owner) { return owner.project?.split('/').filter(Boolean).at(-1) ?? 'Unavailable owner'; }
  function entries(owner: Owner): Entry[] {
    const names = [...new Set([...(owner.previews?.map(p => p.name) ?? []), ...(owner.requests?.map(r => r.name) ?? [])])];
    return names.length ? names.map(name => ({ owner, name, preview: owner.previews?.find(p => p.name === name) })) : [{ owner }];
  }
  function visibleEntries(owner: Owner) {
    const q = search.value.trim().toLowerCase();
    return entries(owner).filter(e => `${owner.project ?? ''} ${e.name ?? ''}`.toLowerCase().includes(q));
  }
  function attempts(p?: PreviewStatus) {
    return [p?.candidate, p?.latest, p?.active].filter((a, i, all): a is AttemptSummary => !!a && all.findIndex(other => other?.id === a.id) === i);
  }
  function select(entry?: Entry) {
    announce(''); selection = entry ? { owner: entry.owner.id, name: entry.name } : undefined; panel = { tab: 'activity' };
    document.body.classList.toggle('show-detail', !!entry); render();
    document.querySelector('#main')!.scrollTop = 0;
    const heading = detail.querySelector('h1'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
  function urlLink(url: string, label: string, className = 'endpoint') {
    const link = el('a', label, className);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' || !(parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.localhost'))) throw new Error();
      link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    } catch { link.removeAttribute('href'); }
    return link;
  }
  function section(title: string, parent = detail) {
    const node = el('section', '', 'section'); node.append(el('h2', title, 'section-label')); parent.append(node); return node;
  }
  function message(title: string, body: string, tone = '', parent = detail) {
    const node = el('section', '', 'notice ' + tone); node.append(el('h2', title), el('p', body)); parent.append(node); return node;
  }
  async function mutate<T = unknown>(body: object, success: string | ((result: T) => string)) {
    acting = true; announce('Working…'); render();
    try { const result = await call<T>(body); announce(typeof success === 'function' ? success(result) : success); }
    catch (error) { announce(error instanceof Error ? error.message : 'The action failed. Check current status before retrying.'); }
    finally { acting = false; snapshot = ''; await refresh(); render(); }
  }
  function actions(entry: Entry): Action[] {
    const { owner, preview: p, name } = entry; const result: Action[] = [];
    for (const request of pending(entry)) if (request.state === 'pending') result.push({ label: 'Open private form', run: () => {
      void mutate({ action: 'secretsOpen', owner: owner.id, id: request.id }, 'Private form requested in your system browser.');
    } });
    if (!p) return result;
    if (p.candidate) result.push({ label: p.active ? 'Cancel update' : 'Cancel startup', danger: true, run: () => {
      void mutate({ action: 'cancel', owner: owner.id, name, attemptId: p.candidate!.id }, 'The selected attempt was canceled.');
    } });
    if ((p.active || needsCleanup(p) || p.url) && !p.busy && !owner.legacy) result.push({ label: needsCleanup(p) ? 'Retry cleanup' : 'Stop', danger: !needsCleanup(p), run: () => {
      void mutate({ action: 'stop', owner: owner.id, name, expected: { active: p.active?.id ?? null, candidate: p.candidate?.id ?? null, latest: p.latest?.id ?? null } }, 'Preview stopped. Your database data is retained.');
    } });
    if (!p.active && !p.busy && !p.candidate && ['stopped', 'failed'].includes(p.latest?.state ?? '') && !owner.legacy && !needsCleanup(p)) result.push({ label: p.latest?.state === 'failed' ? 'Retry start' : 'Start preview', run: () => {
      void mutate({ action: 'startAgain', owner: owner.id, name, attemptId: p.latest!.id }, 'Startup requested with the same configuration and current source.');
    } });
    // Several pending requests may use the same label. The detail's private section retains each exact request.
    return result.filter((action, i) => result.findIndex(other => other.label === action.label) === i);
  }
  function renderList() {
    projects.replaceChildren();
    document.querySelector('#overview')!.setAttribute('aria-current', String(!selection));
    const attention = owners.flatMap(entries).filter(e => e.owner.error || e.owner.configuration?.error || ['error', 'warning'].includes(state(e).tone)).length;
    document.querySelector('#attention-count')!.textContent = attention ? String(attention) : '';
    for (const owner of owners) {
      const list = visibleEntries(owner); if (!list.length) continue;
      const group = el('section', '', 'project'); group.append(el('h2', shortProject(owner), 'section-label'));
      for (const entry of list) {
        const row = navButton('', () => select(entry), 'preview-row', owner.id + (entry.name ?? ''));
        row.setAttribute('aria-current', String(selection?.owner === owner.id && selection.name === entry.name));
        const text = el('span', '', 'nav-identity'); text.append(el('strong', entry.name ?? 'Project'), pathText(owner.project ?? 'Unverified record'));
        row.append(text, el('span', owner.error ? 'Unavailable' : state(entry).label, 'status ' + (owner.error ? 'error' : state(entry).tone)));
        group.append(row);
      }
      projects.append(group);
    }
    if (!projects.children.length) projects.append(el('p', search.value ? 'No matching previews.' : 'No previews found.', 'empty-list'));
  }
  function renderOverview() {
    detail.classList.add('overview');
    const all = owners.flatMap(entries); const list = owners.flatMap(visibleEntries);
    detail.append(el('h1', 'Previews'));
    if (!all.length) {
      const empty = el('div', '', 'empty'); empty.append(el('h2', 'No previews running'), el('p', 'Ask your coding agent to start one. It inspects the project, submits a configuration, and the URL appears here.'), el('pre', 'start a previewhost preview for this worktree'));
      detail.append(empty); return;
    }
    const running = all.filter(e => e.preview?.active).length;
    const starting = all.filter(e => e.preview?.candidate).length;
    const attention = list.filter(e => e.owner.error || e.owner.configuration?.error || ['error', 'warning'].includes(state(e).tone));
    detail.append(el('p', `${running} running · ${starting} starting · ${all.filter(e => e.owner.error || e.owner.configuration?.error || ['error', 'warning'].includes(state(e).tone)).length} need attention`, 'summary'));
    if (!list.length) { detail.append(el('p', 'No matching previews.', 'empty')); return; }
    if (attention.length) {
      const region = el('div', '', 'attention-list');
      attention.forEach((entry, i) => {
        const row = el('div', '', 'notice attention-row');
        const text = el('div'); text.append(el('h2', `${shortProject(entry.owner)} — ${entry.owner.error ? 'status unavailable' : entry.owner.configuration?.error ? 'preview.yml needs attention' : state(entry).note.toLowerCase()}`), el('p', entry.owner.error ? 'Other projects remain available.' : entry.preview?.active ? 'Keep using the running app, or review what needs attention.' : 'Review this worktree before continuing.'));
        row.append(text, navButton('Review', () => select(entry), i === 0 ? 'primary' : '')); region.append(row);
      }); detail.append(region);
    }
    for (const owner of owners) {
      const rows = visibleEntries(owner); if (!rows.length) continue;
      const group = section(shortProject(owner)); const table = el('div', '', 'row-list');
      for (const entry of rows) {
        const row = el('div', '', 'overview-row'); const identity = el('div', '', 'row-identity');
        identity.append(el('strong', entry.name ?? shortProject(owner)), pathText(owner.project ?? 'Unverified record'));
        const status = el('div', '', 'overview-state');
        status.append(el('span', owner.error ? 'Unavailable' : state(entry).label, 'status ' + (owner.error ? 'error' : state(entry).tone)), el('small', owner.error ? 'Owner did not respond' : state(entry).note));
        const controls = el('div', '', 'row-actions');
        if (entry.preview?.active && entry.preview.url) controls.append(urlLink(entry.preview.url, 'Open app', 'button'));
        controls.append(navButton('Details', () => select(entry), '', owner.id + (entry.name ?? '') + '-details'));
        row.append(identity, status, controls); table.append(row);
      }
      group.append(table);
    }
  }
  function hint(entry: Entry) {
    const p = entry.preview;
    if (needsCleanup(p)) return 'Cleanup is incomplete; keep the source directories and retry cleanup before starting again.';
    if (pending(entry).length) return 'Values go to the macOS Keychain. Saving them does not start the app on its own.';
    if (p?.candidate) return p.active ? 'Your app is still available; canceling affects only the pending update in this worktree.' : 'The URL appears once startup checks pass. Cancelling affects only this worktree.';
    if (p?.busy) return 'An operation is in progress; wait for it to finish before changing this preview.';
    if (p?.active && p.latest?.state === 'failed') return 'This opens the serving attempt; the failed update is not serving.';
    if (p?.active) return p.data ? 'Every startup check passed. Stopping keeps your database data.' : 'Every startup check passed. Stopping affects only this preview.';
    if (p?.latest?.state === 'failed') return 'Your app is not serving; resolve the startup error before retrying.';
    if (p?.latest?.state === 'canceled') return 'Startup was canceled; ask your agent to start again only when you want to continue.';
    if (!p) return 'Ask your agent to continue when setup is complete and you want to start this worktree.';
    return p?.data ? 'Start again uses the same configuration, current source and retained database; it does not reload YAML.' : 'Start again uses the same configuration and current source without reloading YAML; the URL may change.';
  }
  function renderRequests(entry: Entry, parent: HTMLElement, shownActions: Set<string>) {
    const list = requests(entry); if (!list.length) return;
    const node = section('Private setup', parent);
    node.append(el('p', 'Approval and values stay in the private form. Saving does not start the application.', 'muted'));
    const labels = { pending: 'Awaiting approval or entry', saving: 'Saving', complete: 'Complete', partial: 'Partly saved', canceled: 'Canceled', expired: 'Expired' };
    for (const request of list) {
      const row = el('div', '', 'request'); row.append(el('strong', labels[request.state]), el('span', `Expires ${new Date(request.expiresAt).toLocaleTimeString()}`, 'machine muted'));
      if (request.state === 'pending' && (!shownActions.has('Open private form') || pending(entry).length > 1)) row.append(button(pending(entry).length > 1 ? 'Open request ' + request.id.slice(0, 8) : 'Open private form', () => {
        void mutate({ action: 'secretsOpen', owner: entry.owner.id, id: request.id }, 'Private form requested in your system browser.');
      }, '', request.id));
      if (request.browser === 'failed' && request.state === 'pending') row.append(el('p', 'The browser did not open. Try opening the private form again.', 'error'));
      if (request.state === 'complete') row.append(el('p', 'If your agent ended its turn, send “Secrets saved—continue” in that chat.', 'muted'));
      if (request.state === 'canceled') row.append(el('p', 'Setup stopped. Ask your agent for a new request only when you want to continue.', 'muted'));
      if (request.state === 'expired' || request.state === 'partial') row.append(el('p', 'Ask your agent to check setup and request any remaining values.', 'muted'));
      node.append(row);
    }
  }
  function renderAttempts(p: PreviewStatus) {
    const latest = p.candidate ?? p.latest;
    if (!latest && !p.active) return;
    if (p.active && latest && p.active.id !== latest.id) {
      const node = section('Attempts'); const split = el('div', '', 'attempt-split');
      for (const [label, attempt, note] of [
        ['Serving now', p.active, 'This is what “Open app” gives you.'],
        ['Latest update', latest, 'Not serving. Source files remain live; these are runtime attempts, not build snapshots.'],
      ] as const) {
        const column = el('div'); column.append(el('p', label, 'muted'), el('code', attempt.id, 'attempt-id'), el('span', attempt.state, 'status ' + (attempt.state === 'failed' ? 'error' : 'muted')), el('p', note)); split.append(column);
      }
      node.append(split);
    } else {
      const attempt = p.active ?? latest!; const row = el('div', '', 'attempt-line');
      row.append(el('span', p.active ? 'Serving / latest' : 'Latest attempt', 'section-label'), el('code', attempt.id, 'attempt-id'), el('span', attempt.state, 'muted')); detail.append(row);
    }
  }
  function renderServices(p: PreviewStatus) {
    const attempt = p.active ?? p.candidate ?? p.latest;
    if (!attempt && !p.data) return;
    const node = section('Services');
    if (p.active && p.candidate) node.append(el('p', 'Serving services are shown below; the update is still starting.', 'muted'));
    const table = el('div', '', 'row-list');
    const managed = new Set(p.data?.resources.map(r => r.name) ?? []);
    const services = Object.entries(attempt?.services ?? {}).sort(([a], [b]) => Number(managed.has(a)) - Number(managed.has(b)));
    if (!services.length && attempt && attempt.type !== 'environment') services.push([p.name, { type: attempt.type, state: attempt.state === 'ready' ? 'ready' : attempt.state === 'starting' ? 'starting' : attempt.state === 'failed' ? 'failed' : 'stopped' }]);
    for (const [name, service] of services) {
      const row = el('div', '', 'service-row' + (managed.has(name) ? ' managed' : ''));
      const url = attempt?.id === p.active?.id ? service.browserUrl : undefined;
      row.append(el('strong', name), el('span', service.type, 'machine muted'), el('span', service.state, 'status ' + (service.state === 'failed' ? 'error' : service.state === 'ready' ? 'ready' : 'muted')));
      const meta = el('span', managed.has(name) ? 'Data retained on stop' : '', 'service-meta muted');
      if (url) { try { meta.textContent = ':' + new URL(url).port; meta.classList.add('machine'); } catch { /* Invalid links are omitted below. */ } }
      row.append(meta, url ? urlLink(url, 'Open', 'button small') : el('span', '', 'service-action'));
      if (service.error) row.append(el('p', service.error.message, 'error service-error'));
      table.append(row);
    }
    for (const resource of p.data?.resources ?? []) {
      if (services.some(([name]) => name === resource.name)) continue;
      const row = el('div', '', 'service-row managed');
      row.append(el('strong', resource.name), el('span', resource.type, 'machine muted'), el('span', 'Retained', 'muted'), el('span', 'Data retained on stop', 'service-meta muted'), el('span'));
      table.append(row);
    }
    if (!table.children.length) table.append(el('p', 'Service status is not available yet.', 'muted'));
    node.append(table);
    if (p.candidate) { const elapsed = el('p', '', 'machine muted'); elapsed.dataset.elapsed = p.candidate.startedAt; node.append(elapsed); }
    if (p.data) node.append(el('p', 'Stopping keeps your database data. Deletion is a separate explicit CLI operation.', 'muted'));
    for (const source of attempt?.sources ?? []) node.append(pathText(source));
  }
  async function loadPanel(entry: Entry, tab: Tab, attempt?: AttemptSummary) {
    const current = panel = { tab, attemptId: attempt?.id, loading: tab !== 'activity' };
    render(); if (tab === 'activity' || !attempt) return;
    try {
      const result = await call<LogResult | PreviewDescription>({ action: tab === 'logs' ? 'logs' : 'describe', owner: entry.owner.id, name: entry.name, attemptId: attempt.id });
      if (panel !== current) return;
      if (tab === 'logs') panel.logs = result as LogResult; else panel.description = result as PreviewDescription;
    } catch (error) { if (panel === current) panel.error = error instanceof Error ? error.message : 'Details unavailable.'; }
    finally { if (panel === current) { panel.loading = false; render(); } }
  }
  function renderConfiguration(entry: Entry, attempt: AttemptSummary, parent: HTMLElement, description: PreviewDescription) {
    parent.append(el('p', 'Requested configuration. Read-only — stored secret values are not included.', 'muted'));
    const env = section('Environment variables', parent); const rows = el('div', '', 'row-list');
    const bindingKeys = new Set([...description.envKeys, ...(description.secrets ?? []).flatMap(secret => secret.bindings.map(binding => (binding.service ? binding.service + '.' : '') + binding.key))]);
    for (const key of bindingKeys) {
      const secret = description.secrets?.find(s => s.bindings.some(b => (b.service ? b.service + '.' : '') + b.key === key));
      const [service, envKey] = key.split('.');
      const binding = description.spec.type === 'environment' ? description.spec.services[service]?.bindings?.[envKey] : undefined;
      const kind = secret ? 'secret ref' : binding ? Object.keys(binding)[0] : 'value omitted';
      const value = secret ? secret.id + (secret.selected ? ' · approved for this owner' : ' · approval required') : binding ? String(Object.values(binding)[0]) : 'Literal value is not included.';
      const row = el('div', '', 'env-row'); row.append(el('code', key), el('span', kind, 'muted'), el('span', value, 'machine muted')); rows.append(row);
    }
    if (!rows.children.length) rows.append(el('p', 'No environment variables declared.', 'empty-list')); env.append(rows);
    const definitions = section('Service definitions', parent); const spec = description.spec;
    if (spec.type === 'environment') {
      const list = el('div', '', 'row-list');
      for (const [name, service] of Object.entries(spec.services)) {
        const row = el('div', '', 'definition-row'); row.append(el('strong', name), el('span', service.type, 'machine muted'));
        if (service.command) row.append(el('pre', JSON.stringify(service.command)));
        if (service.cwd || service.directory) row.append(pathText(service.cwd ?? service.directory!));
        list.append(row);
      }
      definitions.append(list);
    }
    const raw = el('details'); raw.append(el('summary', 'Full requested configuration'), el('pre', JSON.stringify(spec, null, 2), 'configuration')); definitions.append(raw);
    const save = el('div', '', 'save-row'); save.append(el('p', 'Save this configuration as preview.yml so the next agent starts from it. Existing files are never overwritten.'), button('Save as preview.yml', () => {
      void mutate<{ file: string; externalSources: string[] }>({ action: 'saveConfiguration', owner: entry.owner.id, name: entry.name, attemptId: attempt.id }, result => `Saved ${result.file}. The running preview is unchanged.` + (result.externalSources.length ? ' Sources outside this project keep absolute paths: ' + result.externalSources.join(', ') : ''));
    })); parent.append(save);
  }
  function renderTabs(entry: Entry) {
    const p = entry.preview; const retained = attempts(p); const node = el('section', '', 'tabs-section');
    const tabs = el('div', '', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Preview diagnostics');
    const selected = retained.find(a => a.id === panel.attemptId) ?? p?.candidate ?? p?.latest ?? p?.active;
    for (const [tab, label] of [['activity', 'Activity'], ['logs', 'Logs'], ['configuration', 'Configuration']] as const) {
      if (tab !== 'activity' && (!selected || (entry.owner.legacy && tab === 'configuration'))) continue;
      const control = navButton(label, () => { void loadPanel(entry, tab, selected); }, '', 'tab-' + tab);
      control.id = 'tab-' + tab; control.setAttribute('role', 'tab'); control.setAttribute('aria-selected', String(panel.tab === tab)); control.setAttribute('aria-controls', 'tab-content');
      control.tabIndex = panel.tab === tab ? 0 : -1;
      control.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const controls = [...tabs.querySelectorAll<HTMLButtonElement>('button')]; const i = controls.indexOf(control);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
        controls[next].click(); document.getElementById(controls[next].id)?.focus();
      }); tabs.append(control);
    }
    const content = el('div', '', 'tab-content'); content.id = 'tab-content'; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', 'tab-' + panel.tab);
    node.append(tabs, content); detail.append(node);
    if (panel.tab === 'activity') {
      content.append(el('p', 'Retained runtime attempts · source files remain live.', 'muted'));
      for (const attempt of retained) {
        const row = el('div', '', 'activity-row'); row.append(el('time', new Date(attempt.startedAt).toLocaleTimeString(), 'machine muted'));
        const text = el('div'); text.append(el('strong', attempt.id === p?.active?.id ? 'Serving now' : 'Attempt ' + attempt.state), el('code', attempt.id, 'attempt-id'), el('p', attempt.error?.message ?? (attempt.readyAt ? 'Startup checks passed at ' + new Date(attempt.readyAt).toLocaleTimeString() : 'Started at the time shown.'), attempt.error ? 'error' : 'muted')); row.append(text); content.append(row);
      }
      if (!retained.length) content.append(el('p', 'No retained attempts. Start through your agent or CLI.', 'muted'));
      if (p?.cleanup?.length || p?.data?.cleanup) {
        const cleanup = message('Cleanup needs attention', 'Keep these source directories until cleanup succeeds.', 'error', content);
        for (const item of p.cleanup ?? []) cleanup.append(el('p', item.error.message), ...item.sources.map(pathText));
        if (p.data?.cleanup) cleanup.append(el('p', p.data.cleanup.message));
      }
      renderRequests(entry, content, new Set(actions(entry).map(a => a.label))); return;
    }
    if (!selected) { content.append(el('p', 'The retained attempt is no longer available.', 'muted')); return; }
    const choose = el('label', '', 'attempt-picker'); choose.append(el('span', 'Attempt'));
    const selectAttempt = el('select'); selectAttempt.setAttribute('aria-label', 'Diagnostic attempt'); selectAttempt.dataset.focus = 'diagnostic-attempt';
    for (const attempt of retained) {
      const option = el('option', (attempt.id === p?.active?.id ? 'Serving' : attempt.id === p?.candidate?.id ? 'Starting' : 'Latest') + ' · ' + attempt.id);
      option.value = attempt.id; option.selected = attempt.id === selected.id; selectAttempt.append(option);
    }
    selectAttempt.addEventListener('change', () => { void loadPanel(entry, panel.tab, retained.find(a => a.id === selectAttempt.value)); });
    choose.append(selectAttempt, button('Refresh', () => { void loadPanel(entry, panel.tab, selected); }, 'small', 'refresh-panel')); content.append(choose);
    if (panel.loading) { content.append(el('p', 'Loading…', 'muted')); return; }
    if (panel.error) { message('Details unavailable', panel.error, 'error', content); return; }
    if (panel.attemptId !== selected.id) { content.append(el('p', 'The selected attempt changed. Refresh to load its details.', 'muted')); return; }
    if (panel.tab === 'logs' && panel.logs) {
      content.append(el('p', panel.logs.truncated ? 'Log tail · earlier output omitted' : 'Log tail', 'muted'), el('pre', panel.logs.text || 'No output captured.', 'logs'));
    } else if (panel.description) renderConfiguration(entry, selected, content, panel.description);
  }
  function renderDetail() {
    detail.replaceChildren(); detail.classList.remove('overview');
    document.querySelector('#crumb')!.textContent = selection ? 'Preview details' : 'All previews';
    if (!selection) { renderOverview(); return; }
    const owner = owners.find(o => o.id === selection!.owner);
    if (!owner) { message('Project no longer listed', 'Its owner may have shut down. Stored database data remains separate; start through your agent or CLI to reconnect.'); return; }
    const entry: Entry = { owner, name: selection.name, preview: owner.previews?.find(p => p.name === selection!.name) };
    const p = entry.preview; const status = state(entry);
    const crumb = el('div', '', 'breadcrumb'); crumb.append(navButton('All previews', () => select(), 'text-button'), el('span', '/', 'slash'), el('span', shortProject(owner))); detail.append(crumb);
    const title = el('div', '', 'title-row'); const identity = el('div'); identity.append(el('h1', shortProject(owner)), el('p', entry.name ?? 'Project', 'muted'));
    title.append(identity); if (!owner.error) title.append(el('span', status.label, 'status ' + status.tone)); detail.append(title);
    if (owner.project) detail.append(pathBar(owner.project));
    if (owner.error) { message('Status unavailable', owner.error.message + ' Other projects remain available.', 'error'); return; }
    const availableActions = actions(entry); const taken = new Set(availableActions.map(a => a.label));
    const addNotice = (heading: string, body: string, tone = '', extra?: Action) => {
      const node = message(heading, body, tone);
      if (extra && !taken.has(extra.label)) { node.append(button(extra.label, extra.run)); taken.add(extra.label); }
    };
    if (needsCleanup(p)) addNotice('Cleanup needs attention', 'Some owned resources could not be confirmed stopped. Inspect the details before retrying cleanup.', 'error');
    else if (pending(entry).length) addNotice('Private setup requested', 'Approve access and enter any missing values in the separate private form. Cancellation stays in that form.', 'warning');
    else if (!p?.candidate && p?.latest?.state === 'failed') addNotice(p.active ? 'The update failed. Your previous version is still running.' : 'Startup failed. Your app is not running.', p.latest.error?.message ?? 'Review the latest attempt for details.', 'error', { label: 'View error log', run: () => { void loadPanel(entry, 'logs', p.latest); const content = document.getElementById('tab-content'); if (content) { content.tabIndex = -1; content.focus(); content.scrollIntoView({ block: 'start' }); } } });
    else if (!p?.candidate && p?.latest?.state === 'canceled') addNotice(p.active ? 'The update was canceled. Your previous version is still running.' : 'Startup was canceled.', 'Nothing was started again automatically. Ask your agent to continue only when you are ready.');
    if (owner.legacy) addNotice('Owner update needed', 'This owner runs an older build. New controls require an explicit owner upgrade; this page will not restart it.');
    const row = el('div', '', 'actions');
    const canOpen = !!(p?.active && p.url); let primaryTaken = canOpen;
    if (canOpen) {
      row.append(urlLink(p!.url!, 'Open app', 'button primary hero'));
      const url = el('div', '', 'url-chip'); url.append(el('code', p!.url!), copy(p!.url!)); row.append(url);
    }
    const controls = el('div', '', 'secondary-actions');
    for (const action of availableActions) {
      const primary = !primaryTaken && !action.danger; if (primary) primaryTaken = true;
      const control = button(action.label, action.run, primary ? 'primary hero' : action.danger ? 'danger' : '');
      if (primary) row.append(control); else controls.append(control);
    }
    if (!canOpen && !primaryTaken && p?.candidate) { const waiting = el('button', 'Waiting for URL', 'hero'); waiting.disabled = true; row.append(waiting); }
    row.append(controls); detail.append(row, el('p', hint(entry), 'hint'));
    if (p) { renderAttempts(p); renderServices(p); }
    if (owner.configuration?.error) addNotice('preview.yml needs attention', owner.configuration.error.message + (p?.active ? ' The running app is unchanged. Its Configuration tab shows the serving attempt.' : ' Ask your agent to resolve this configuration error before starting.'), 'error');
    else if (owner.configuration) detail.append(el('p', 'preview.yml is available for the next agent startup. Start again uses the retained attempt configuration.', 'muted'));

    if (owner.legacy && p?.active) message('Stop through the CLI', `Run previewhost stop ${p.name} from the project directory shown above; this owner cannot guard a stale dashboard action.`);
    if (!p?.active && !p?.candidate && !availableActions.length && !pending(entry).length) detail.append(el('p', `Ask your agent to start ${entry.name ?? 'an application'} in this worktree.`, 'muted'));
    renderTabs(entry);
  }
  function render() {
    const focus = (document.activeElement as HTMLElement)?.dataset.focus;
    renderList(); renderDetail(); updateElapsed();
    if (focus) document.querySelector<HTMLElement>('[data-focus="' + CSS.escape(focus) + '"]')?.focus({ preventScroll: true });
  }
  function updateElapsed() {
    for (const node of document.querySelectorAll<HTMLElement>('[data-elapsed]')) node.textContent = Math.max(0, Math.floor((Date.now() - Date.parse(node.dataset.elapsed!)) / 1000)) + 's elapsed';
  }
  async function refresh() {
    if (loading || document.hidden) return;
    loading = true;
    try {
      const result = await call<Owner[]>({ action: 'list' }); connection.textContent = 'Running locally';
      if (connectionNotice) announce('');
      const next = JSON.stringify(result); if (next !== snapshot) { owners = result; snapshot = next; render(); }
      updateElapsed();
    } catch (error) {
      connection.textContent = 'Disconnected';
      announce(capability ? 'Dashboard disconnected. Your previews may still be running. Run previewhost dashboard to reopen it.' : 'Run previewhost dashboard to open an authenticated session. This tab has no usable private session.', true);
      if (!capability) { document.body.classList.add('show-detail'); detail.replaceChildren(el('h1', 'Open from your terminal'), el('pre', 'previewhost dashboard'), el('p', 'The launcher opens a private local session. No account is needed.', 'muted')); }
      else if (error instanceof Error && error.message.includes('too large')) announce(error.message);
    } finally { loading = false; }
  }
  search.addEventListener('input', render);
  document.querySelector('#home')!.addEventListener('click', () => select());
  document.querySelector('#overview')!.addEventListener('click', () => select());
  document.querySelector('#refresh')!.addEventListener('click', () => { snapshot = ''; void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh(); setInterval(() => { if (capability) void refresh(); }, 2500);
}

export const dashboardScript = themeScript + `(${mountDashboard.toString()})();`;
export const dashboardStyle = uiStyle + `
#connection { margin-left:auto; color:var(--t5); font-size:12.5px; }
body { height:100dvh; display:flex; flex-direction:column; }
#notice { padding:10px 20px; border-bottom:1px solid var(--border); background:var(--subtle); color:var(--t3); font-size:13px; }
.workspace { display:grid; grid-template-columns:236px minmax(0,1fr); flex:1; min-height:0; }
aside { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--border); }
.search { display:block; padding:14px 14px 10px; }
input { width:100%; height:32px; padding:0 11px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--t1); font-size:13px; }
input::placeholder { color:var(--t5); }
.nav-overview { margin:0 10px 8px; justify-content:space-between; border:0; height:34px; padding:0 9px; }
.nav-overview[aria-current=true] { background:var(--sel); }
#attention-count { color:var(--t5); font-family:'Geist Mono',monospace; font-size:11.5px; }
#projects { flex:1; min-height:0; overflow-y:auto; padding:4px 10px 16px; }
.project { margin-bottom:16px; }
.project>.section-label { margin:0; padding:6px 8px 5px; }
.preview-row { display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:8px; row-gap:1px; height:auto; width:100%; padding:7px 9px; border:0; margin-top:1px; white-space:normal; text-align:left; }
.preview-row:hover,.nav-overview:hover { background:var(--hover); }
.preview-row[aria-current=true] { background:var(--sel); }
.nav-identity { display:contents; }
.nav-identity strong { display:block; min-width:0; grid-column:1; grid-row:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13.5px; font-weight:500; }
.nav-identity .path { grid-column:1/-1; grid-row:2; font-size:11px; margin-top:1px; }
.nav-identity .path-tail { max-width:100%; white-space:normal; overflow-wrap:anywhere; color:var(--t2); }
.nav-identity .path-parent { display:none; }
.preview-row>.status { grid-column:2; grid-row:1; font-size:11.5px; }
.preview-row>.ready,.preview-row>.muted { color:var(--t5); font-weight:400; }
.scope { border-top:1px solid var(--border); margin:0; padding:12px 16px; font-size:12px; color:var(--t5); line-height:1.45; }
#main { min-width:0; min-height:0; overflow-y:auto; }
#detail { padding:30px 32px 64px; max-width:960px; }
#detail.overview { max-width:1120px; }
.overview>h1 { font-size:26px; letter-spacing:-.6px; }
.breadcrumb { display:flex; align-items:baseline; gap:9px; margin-bottom:10px; font-size:13px; color:var(--t5); }
.text-button { height:auto; border:0; padding:0; background:none; color:var(--t5); font-weight:400; }
.title-row { display:flex; align-items:flex-start; gap:20px; margin-bottom:14px; }
.title-row>div { flex:1; min-width:0; }
.title-row>.status { font-size:14px; padding-top:6px; }
.title-row p { margin:0; font-size:13px; }
.path-bar { display:flex; align-items:center; gap:10px; padding:9px 12px; border:1px solid var(--border); border-radius:7px; background:var(--subtle); margin-bottom:26px; }
.path-bar>.path { flex:1; }
.secondary-actions { display:flex; gap:8px; flex-wrap:wrap; margin-left:auto; }
.url-chip { display:flex; align-items:center; gap:12px; min-width:0; max-width:100%; height:36px; padding:0 13px; border:1px solid var(--border); border-radius:6px; background:var(--subtle); }
.url-chip code { color:var(--t2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.url-chip button { border:0; padding:0; background:none; color:var(--t5); }
.hint { margin:0; padding-bottom:26px; border-bottom:1px solid var(--border); color:var(--t4); font-size:13px; line-height:1.6; }
.section { padding:26px 0; border-bottom:1px solid var(--border); }
.section>.section-label { margin-bottom:16px; }
.section>.path { margin-top:10px; }
.section>p { font-size:12.5px; }
.attempt-line { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; padding:18px 0; border-bottom:1px solid var(--border); }
.attempt-line>.section-label { width:110px; }
.attempt-id { font-size:12px; overflow-wrap:anywhere; }
.attempt-split { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.attempt-split>div { padding:16px 18px; min-width:0; }
.attempt-split>div+div { border-left:1px solid var(--border); }
.attempt-split .attempt-id { display:block; margin:6px 0; }
.attempt-split p { font-size:12.5px; color:var(--t4); }
.attempt-split p:last-child { margin-top:10px; margin-bottom:0; }
.row-list { border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.row-list>div+div { border-top:1px solid var(--divider); }
.service-row { display:grid; grid-template-columns:96px 96px 72px minmax(0,1fr) 56px; align-items:center; gap:12px; padding:12px 16px; }
.service-row>strong { overflow-wrap:anywhere; font-size:13.5px; }
.service-row .status { font-size:12.5px; }
.service-row .ready { font-weight:400; }
.service-row.managed { background:var(--subtle); }
.service-meta { text-align:right; font-size:12px; }
.service-error { grid-column:1/-1; margin:0; font-size:12.5px; }
.overview .section { border-bottom:0; padding:0; margin-bottom:30px; }
.overview .section-label { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
.overview .section-label::after { content:''; flex:1; height:1px; background:var(--divider); }
.summary { color:var(--t4); margin:6px 0 26px; }
.attention-list { display:flex; flex-direction:column; gap:10px; margin-bottom:30px; }
.attention-row { display:flex; align-items:center; gap:16px; padding:14px 16px; margin:0; }
.attention-row>div { flex:1; min-width:0; }
.attention-row h2 { font-size:14px; font-weight:500; letter-spacing:0; }
.attention-row p { font-size:13px; }
.attention-row button { margin:0; }
.overview-row { display:grid; grid-template-columns:minmax(0,1fr) 160px 164px; align-items:center; gap:20px; padding:14px 16px; }
.row-identity { min-width:0; }
.row-identity>.path { font-size:11.5px; margin-top:2px; }
.row-identity .path-tail { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.overview-state { font-size:13px; }
.overview-state small { display:block; font-size:12px; color:var(--t5); margin-top:2px; }
.row-actions { display:flex; justify-content:flex-end; gap:8px; }
.row-actions button,.row-actions .button { height:30px; padding:0 12px; }
.tabs-section { padding-top:26px; }
.tabs { display:flex; align-items:center; gap:22px; border-bottom:1px solid var(--border); margin-bottom:20px; }
.tabs button { border:0; border-radius:0; padding:0 0 12px; height:auto; color:var(--t5); background:none; font-weight:400; }
.tabs button[aria-selected=true] { border-bottom:1px solid var(--t1); color:var(--t1); font-weight:500; }
.tab-content .section { padding-top:0; border:0; }
.activity-row { display:flex; align-items:baseline; gap:16px; padding:12px 0; }
.activity-row+.activity-row { border-top:1px solid var(--divider-2); }
.activity-row time { width:90px; flex:none; font-size:12px; }
.activity-row>div { min-width:0; }
.activity-row code { display:block; margin:3px 0; }
.activity-row p { margin:0; font-size:12.5px; }
.attempt-picker { display:flex; gap:10px; align-items:center; margin-bottom:16px; color:var(--t4); font-size:12.5px; }
select { min-width:0; max-width:100%; height:32px; padding:0 8px; border:1px solid var(--border-2); border-radius:6px; background:var(--bg); color:var(--t2); font-family:'Geist Mono',monospace; font-size:12px; }
.logs,.configuration { border:1px solid var(--border); border-radius:8px; background:var(--subtle); padding:14px 16px; max-height:360px; overflow:auto; white-space:pre; line-height:1.9; font-size:12px; color:var(--t3); }
.env-row { display:grid; grid-template-columns:180px 90px minmax(0,1fr); gap:14px; align-items:baseline; padding:11px 16px; }
.env-row>* { overflow-wrap:anywhere; font-size:12px; }
.definition-row { padding:13px 16px; }
.definition-row>strong { margin-right:10px; }
.definition-row pre { margin:5px 0; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--t3); }
details { margin:16px 0; }
summary { cursor:pointer; color:var(--t4); font-size:13px; }
.save-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; border:1px dashed var(--border-2); border-radius:8px; padding:14px 16px; }
.save-row p { flex:1; min-width:180px; margin:0; font-size:13px; color:var(--t4); }
.request { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; padding:12px 0; font-size:13px; }
.request+.request { border-top:1px solid var(--divider); }
.request p { width:100%; margin:0; }
.empty { padding:64px 0; max-width:460px; }
.empty h2 { font-size:20px; letter-spacing:-.3px; }
.empty p { font-size:14px; color:var(--t4); line-height:1.6; }
.empty pre { white-space:pre-wrap; padding:12px 14px; border:1px solid var(--border); border-radius:8px; background:var(--subtle); color:var(--t4); }
.empty-list { padding:12px 16px; color:var(--t5); font-size:13px; }
@media (max-width:1100px) {
  .overview-row { grid-template-columns:minmax(0,1fr) 150px; gap:12px; }
  .row-actions { grid-column:1/-1; }
  .service-row { grid-template-columns:80px 76px 64px minmax(0,1fr) 48px; gap:8px; padding:12px; }
}
@media (max-width:760px) {
  header { padding:0 14px; gap:10px; }
  #crumb,#connection,header>.slash { display:none; }
  header .brand { margin-right:auto; }
  .workspace { display:flex; flex-direction:column; }
  aside { border-right:0; max-height:45%; flex:none; border-bottom:1px solid var(--border); }
  .scope { display:none; }
  #projects { display:none; }
  .show-detail aside .search { display:none; }
  .show-detail .nav-overview { margin:8px 14px; }
  #main { flex:1; }
  #detail { padding:24px 20px 40px; }
  .title-row { gap:10px; }
  h1 { font-size:26px; }
  .title-row>.status { font-size:12px; }
  .path-bar>.path { flex-wrap:wrap; }
  .path-bar .path-parent { flex-basis:100%; }
  .path-bar .path-tail { white-space:normal; overflow-wrap:anywhere; flex:1; }
  .section>.path,.definition-row>.path { flex-wrap:wrap; }
  .section>.path .path-tail,.definition-row>.path .path-tail { white-space:normal; overflow-wrap:anywhere; flex-shrink:1; }
  .attempt-split { grid-template-columns:1fr; }
  .attempt-split>div+div { border-left:0; border-top:1px solid var(--border); }
  .overview-row { grid-template-columns:minmax(0,1fr) 130px; gap:10px; padding:12px; }
  .overview-state .status { font-size:12px; }
  .overview-state small { font-size:11px; }
  .service-row { grid-template-columns:72px 66px minmax(0,1fr) 48px; }
  .service-meta { grid-column:1/4; grid-row:auto; text-align:left; }
  .service-row>.button,.service-action { grid-column:4; }
  .service-row>.status { text-align:right; }
  .env-row { grid-template-columns:minmax(0,1fr) 90px; }
  .env-row>:last-child { grid-column:1/-1; }
  .attempt-picker { flex-wrap:wrap; }
  .attempt-picker select { flex:1; }
  .secondary-actions { margin-left:0; }
  .attention-row { align-items:flex-start; padding:14px; }
  .activity-row { flex-wrap:wrap; gap:4px; }
  .activity-row>div { width:100%; }
}
`;
