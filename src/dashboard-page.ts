import { uiStyle, themeScript } from './ui.js';
import type { AttemptSummary, LogResult, PreviewDescription, PreviewStatus, SecretSetupSummary } from './contracts.js';

export const dashboardPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Previews · Previewhost</title><link rel="stylesheet" href="/dashboard.css"></head>
<body><header><button id="home" class="brand">previewhost</button><span class="slash">/</span><span id="crumb">All previews</span>
<span id="connection">Connecting…</span><button id="theme" aria-label="Switch to dark theme">Dark</button><button id="refresh">Refresh</button></header>
<div id="notice" role="status" hidden></div>
<div class="workspace"><aside><label class="search"><span class="sr-only">Search projects and previews</span><input id="search" placeholder="Search" type="search"></label>
<button id="overview" class="nav-overview">All previews<span id="preview-count"></span></button>
<button id="secret-manager" class="nav-overview">Secret Manager</button>
<nav id="projects" aria-label="Projects and previews"></nav><p class="scope">Closing this window leaves previews running.</p></aside>
<main id="main"><article id="detail" aria-label="Preview details"><p class="muted">Connecting to local previews…</p></article></main></div>
<dialog id="secret-edit" aria-labelledby="secret-edit-title" aria-describedby="secret-edit-hint">
<form id="secret-edit-form" autocomplete="off">
<h2 id="secret-edit-title">Edit secret</h2><p id="secret-edit-name" class="machine"></p>
<p id="secret-edit-hint">Replace this value for future starts in every project that uses this reference. Running apps stay unchanged.</p>
<label for="secret-value">New value</label><textarea id="secret-value" class="machine" required spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"></textarea>
<p class="muted">Stored values are never shown. Saved securely in macOS Keychain.</p>
<p id="secret-edit-error" class="error" role="alert" hidden></p>
<div class="actions"><button id="secret-edit-cancel" type="button">Cancel</button><button id="secret-edit-save" class="primary" type="submit">Save</button></div>
</form></dialog>
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
  let secretManager = false;
  let secretList: { ids: string[]; truncated: boolean } | undefined;
  let secretError: string | undefined;
  let selection: { owner: string; name?: string } | undefined;
  let snapshot = '';
  let logQuery = '';
  let loading = false;
  let acting = false;
  let connectionNotice = false;
  let panel: { tab: Tab; attemptId?: string; source?: string; loading?: boolean; error?: string; logs?: LogResult; description?: PreviewDescription } = { tab: 'activity' };
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
    const parts = path.split('/'); const folder = parts.pop()!; const directory = parts.pop();
    const tail = el('span', '', 'path-tail');
    tail.append(el('span', directory === undefined ? '' : directory + '/', 'path-directory'), el('span', folder, 'path-folder'));
    node.append(el('span', parts.length ? parts.join('/') + '/' : '', 'path-parent'), tail);
    return node;
  }
  function scrollList(label: string) {
    const node = el('div', '', 'row-list scroll-list');
    node.tabIndex = 0; node.setAttribute('role', 'region'); node.setAttribute('aria-label', label); node.dataset.scroll = label; node.dataset.focus = 'scroll-' + label;
    return node;
  }
  async function call<T>(body: object): Promise<T> {
    const response = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + capability }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error?.code === 'NOT_FOUND' && data.error.message === 'Unknown control operation.' && 'action' in body && body.action === 'saveConfiguration') {
      throw new Error('This owner does not support configuration saving. Ask your agent to save preview.yml, or upgrade the owner when you are ready to stop its previews.');
    }
    if (data.error) throw new Error(data.error.code === 'STALE_ATTEMPT' ? 'This preview changed. Review its current state and try again.' : data.error.message, { cause: data.error });
    return data.result;
  }
  function needsCleanup(preview?: PreviewStatus) {
    return !!(preview?.cleanup?.length || preview?.data?.cleanup ||
      [preview?.active, preview?.candidate, preview?.latest].some(attempt => attempt?.state === 'cleanup-incomplete'));
  }
  function deletionNeedsRetry(p?: PreviewStatus) {
    return p?.data?.cleanup?.operation === 'remove-credential' && !p.cleanup?.length &&
      !attempts(p).some(attempt => attempt.state === 'cleanup-incomplete');
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
    const q = secretManager ? '' : search.value.trim().toLowerCase();
    return entries(owner).filter(e => `${owner.project ?? ''} ${e.name ?? ''}`.toLowerCase().includes(q));
  }
  function attempts(p?: PreviewStatus) {
    return [p?.candidate, p?.latest, p?.active].filter((a, i, all): a is AttemptSummary => !!a && all.findIndex(other => other?.id === a.id) === i);
  }
  function select(entry?: Entry) {
    if (secretManager) search.value = '';
    secretManager = false;
    announce(''); logQuery = ''; selection = entry ? { owner: entry.owner.id, name: entry.name } : undefined; panel = { tab: 'activity' };
    document.body.classList.toggle('show-detail', !!entry); render();
    for (const node of document.querySelectorAll('#main, .tab-body')) { node.scrollTop = 0; node.scrollLeft = 0; }
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
    // The header opens the first pending request; Activity retains every exact request.
    const request = pending(entry).find(request => request.state === 'pending');
    if (request) result.push({ label: 'Open private form', run: () => {
      void mutate({ action: 'secretsOpen', owner: owner.id, id: request.id }, 'Private form requested in your system browser.');
    } });
    if (!p) return result;
    if (p.candidate) result.push({ label: p.active ? 'Cancel update' : 'Cancel startup', danger: true, run: () => {
      void mutate({ action: 'cancel', owner: owner.id, name, attemptId: p.candidate!.id }, 'The selected attempt was canceled.');
    } });
    if ((p.active || needsCleanup(p) || p.url) && !deletionNeedsRetry(p) && !p.busy && !owner.legacy) result.push({ label: needsCleanup(p) ? 'Retry cleanup' : 'Stop', danger: !needsCleanup(p), run: () => {
      void mutate({ action: 'stop', owner: owner.id, name, expected: { active: p.active?.id ?? null, candidate: p.candidate?.id ?? null, latest: p.latest?.id ?? null } }, 'Preview stopped. Your database data is retained.');
    } });
    if (!p.active && !p.busy && !p.candidate && ['stopped', 'failed'].includes(p.latest?.state ?? '') && !owner.legacy && !needsCleanup(p)) result.push({ label: p.latest?.state === 'failed' ? 'Retry start' : 'Start preview', run: () => {
      void mutate({ action: 'startAgain', owner: owner.id, name, attemptId: p.latest!.id }, 'Startup requested with the same configuration and current source.');
    } });
    return result;
  }
  function renderList() {
    projects.replaceChildren();
    document.querySelector('#overview')!.setAttribute('aria-current', String(!secretManager && !selection));
    document.querySelector('#secret-manager')!.setAttribute('aria-current', String(secretManager));
    search.placeholder = secretManager ? 'Search references' : 'Search';
    document.querySelector('.search .sr-only')!.textContent = secretManager ? 'Search secret references' : 'Search projects and previews';
    document.querySelector('#preview-count')!.textContent = String(owners.flatMap(entries).length);
    for (const owner of owners) {
      const list = visibleEntries(owner); if (!list.length) continue;
      const group = el('section', '', 'project'); const heading = el('h2', shortProject(owner), 'section-label'); heading.title = owner.project ?? ''; if (list.length > 1) group.append(heading);
      for (const entry of list) {
        const row = navButton('', () => select(entry), 'preview-row', owner.id + (entry.name ?? ''));
        row.setAttribute('aria-current', String(!secretManager && selection?.owner === owner.id && selection.name === entry.name));
        const text = el('span', '', 'nav-identity'); text.append(el('strong', entry.name ?? shortProject(owner)), pathText(owner.project ?? 'Unverified record'));
        row.append(text, el('span', owner.error ? 'Unavailable' : state(entry).label, 'status ' + (owner.error ? 'error' : state(entry).tone)));
        group.append(row);
      }
      projects.append(group);
    }
    if (!projects.children.length) projects.append(el('p', !secretManager && search.value ? 'No matching previews.' : 'No previews found.', 'empty-list'));
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
    detail.append(el('p', `${running} running · ${starting} starting · ${all.filter(e => e.owner.error || e.owner.configuration?.error || ['error', 'warning'].includes(state(e).tone)).length} need attention`, 'summary'));
    if (!list.length) { detail.append(el('p', 'No matching previews.', 'empty')); return; }
    const table = el('div', '', 'row-list overview-list'); detail.append(table);
    for (const owner of owners) {
      const rows = visibleEntries(owner); if (!rows.length) continue;
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
    }
  }
  function hint(entry: Entry) {
    const p = entry.preview;
    if (deletionNeedsRetry(p)) return 'Nothing restarts until you explicitly retry Reset data.';
    if (needsCleanup(p)) return 'Cleanup is incomplete; keep the source directories and retry cleanup before starting again.';
    if (pending(entry).length) return 'Values go to the macOS Keychain. Saving them does not start the app on its own.';
    if (p?.candidate) return p.active ? 'Your app is still available; canceling affects only the pending update in this worktree.' : 'The URL appears once startup checks pass. Cancelling affects only this worktree.';
    if (p?.busy) return 'An operation is in progress; wait for it to finish before changing this preview.';
    if (p?.active && p.latest?.state === 'failed') return 'Your previous app is still running.';
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
  function renderAttempts(p: PreviewStatus, parent: HTMLElement) {
    const latest = p.candidate ?? p.latest;
    if (!latest && !p.active) return;
    if (p.active && latest && p.active.id !== latest.id) {
      const split = el('div', '', 'attempt-split');
      for (const [label, attempt] of [
        ['Serving', p.active],
        ['Latest update', latest],
      ] as const) {
        const id = el('code', attempt.id.slice(0, 8), 'attempt-id'); id.title = attempt.id;
        const column = el('div'); column.append(el('p', label, 'muted'), id, el('span', attempt.state[0].toUpperCase() + attempt.state.slice(1), 'status ' + (attempt.state === 'failed' ? 'error' : attempt.state === 'ready' ? 'ready' : 'muted'))); split.append(column);
      }
      parent.append(split);
    } else {
      const attempt = p.active ?? latest!; const row = el('div', '', 'attempt-line');
      const id = el('code', attempt.id.slice(0, 8), 'attempt-id'); id.title = attempt.id;
      row.append(el('span', p.active ? 'Serving' : 'Latest attempt', 'section-label'), id); parent.append(row);
    }
  }
  function renderServices(entry: Entry, parent: HTMLElement) {
    const p = entry.preview!;
    const attempt = p.active ?? p.candidate ?? p.latest;
    if (!attempt && !p.data) return;
    const node = section('Services', parent);
    if (p.active && p.candidate) node.append(el('p', 'Serving services are shown below; the update is still starting.', 'muted'));
    const table = el('div', '', 'row-list');
    const managed = new Set(p.data?.resources.map(r => r.name) ?? []);
    const dataLabel = p.data?.cleanup?.operation === 'remove-credential' ? 'Data deleted' : p.data?.cleanup ? 'Check data' : 'Data retained';
    const typeLabels = { command: 'HTTP', static: 'Static', attach: 'Attached HTTP', postgres: 'PostgreSQL', redis: 'Redis', 'external-postgres': 'PostgreSQL', 'external-redis': 'Redis' };
    const services = Object.entries(attempt?.services ?? {}).sort(([a], [b]) => Number(managed.has(a)) - Number(managed.has(b)));
    if (!services.length && attempt && attempt.type !== 'environment') services.push([p.name, { type: attempt.type, state: attempt.state === 'ready' ? 'ready' : attempt.state === 'starting' ? 'starting' : attempt.state === 'failed' ? 'failed' : 'stopped' }]);
    for (const [name, service] of services) {
      if (service.type === 'job') continue;
      const row = el('div', '', 'service-row' + (managed.has(name) ? ' managed' : ''));
      const url = attempt?.id === p.active?.id ? service.browserUrl : undefined;
      row.append(el('strong', name), el('span', typeLabels[service.type], 'muted'), el('span', service.state[0].toUpperCase() + service.state.slice(1), 'status ' + (service.state === 'failed' ? 'error' : service.state === 'ready' ? 'ready' : 'muted')));
      const meta = el('span', managed.has(name) ? dataLabel : '', 'service-meta muted');
      if (url) { try { meta.textContent = ':' + new URL(url).port; meta.classList.add('machine'); } catch { /* Invalid links are omitted below. */ } }
      const controls = el('div', '', 'row-actions service-action');
      if (service.type === 'command') controls.append(button('Logs', () => openLogs(entry, attempt!, name), 'small', 'logs-' + name));
      if (url) controls.append(urlLink(url, 'Open', 'button small'));
      row.append(meta, controls);
      if (service.error) row.append(el('p', service.error.message, 'error service-error'));
      table.append(row);
    }
    for (const resource of p.data?.resources ?? []) {
      if (services.some(([name]) => name === resource.name)) continue;
      const row = el('div', '', 'service-row managed');
      row.append(el('strong', resource.name), el('span', typeLabels[resource.type], 'muted'), el('span', p.data?.cleanup ? 'Needs cleanup' : 'Retained', 'muted'), el('span', dataLabel, 'service-meta muted'), el('span'));
      table.append(row);
    }
    if (!table.children.length) table.append(el('p', 'Service status is not available yet.', 'muted'));
    node.append(table);
    if (p.data?.resources.length && p.latest && (p.active || ['stopped', 'failed'].includes(p.latest.state)) &&
        !p.busy && !p.candidate && (!needsCleanup(p) || deletionNeedsRetry(p)) && !entry.owner.legacy) {
      const reset = el('div', '', 'reset-row');
      reset.append(el('p', 'Reset managed data and run setup again.', 'muted'), button('Reset data', () => confirmReset(entry), 'danger small'));
      node.append(reset);
    }
    if (p.candidate) { const elapsed = el('p', '', 'machine muted'); elapsed.dataset.elapsed = p.candidate.startedAt; node.append(elapsed); }
    if (attempt?.sources?.length) {
      const sources = el('details', '', 'source-folders'); sources.append(el('summary', 'Source folders')); sources.dataset.disclosure = 'sources';
      for (const source of attempt.sources) sources.append(pathText(source));
      node.append(sources);
    }
  }
  function confirmReset(entry: Entry) {
    const p = entry.preview!;
    const dialog = el('dialog'); dialog.setAttribute('aria-labelledby', 'reset-title'); dialog.setAttribute('aria-describedby', 'reset-hint');
    const title = el('h2', 'Reset data for ' + p.name + '?'); title.id = 'reset-title';
    const hint = el('p', 'Stops this preview, deletes the managed data below, then starts the ' + (p.active ? 'serving' : 'latest') + ' configuration and runs setup again. Deletion and job writes cannot be rolled back.', 'muted'); hint.id = 'reset-hint';
    const list = el('ul', '', 'reset-resources');
    for (const resource of p.data!.resources) list.append(el('li', resource.name + ' · ' + (resource.type === 'postgres' ? 'PostgreSQL' : 'Redis')));
    const controls = el('div', '', 'actions'); const cancel = button('Cancel', () => dialog.close()); cancel.autofocus = true;
    controls.append(cancel, button('Delete data and start', () => {
      dialog.close();
      void mutate({ action: 'resetData', owner: entry.owner.id, name: p.name, resources: p.data!.resources,
        expected: { active: p.active?.id ?? null, candidate: p.candidate?.id ?? null, latest: p.latest!.id } }, 'Data deleted. Startup requested; check setup jobs below.');
    }, 'danger'));
    dialog.append(title, pathText(entry.owner.project ?? ''), hint, list, el('p', 'External databases and saved secrets are not deleted.', 'muted'), controls);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  function renderJobs(entry: Entry, parent: HTMLElement) {
    const p = entry.preview!; const attempt = p.candidate ?? p.latest ?? p.active;
    const jobs = Object.entries(attempt?.services ?? {}).filter(([, s]) => s.type === 'job');
    if (!jobs.length || !attempt) return;
    const node = section('Setup jobs', parent); const list = el('div', '', 'row-list');
    const heading = el('div', '', 'section-heading'); heading.append(node.firstElementChild!);
    if (p.active && p.active.id !== attempt.id) heading.append(el('span', 'Latest update', 'muted'));
    node.append(heading);
    for (const [name, job] of jobs) {
      const row = el('div', '', 'job-row');
      const label = job.state === 'skipped' ? 'Skipped' : job.state === 'starting' ? 'Running' : job.state[0].toUpperCase() + job.state.slice(1);
      const identity = el('div', '', 'job-identity'); identity.append(el('strong', name));
      if (job.error) identity.append(el('p', job.error.message, 'job-note'));
      else if (job.state === 'skipped') identity.append(el('p', 'Already applied to retained data.', 'job-note'));
      row.append(identity, el('span', label, 'status ' + (job.state === 'failed' ? 'error' : job.state === 'succeeded' ? 'ready' : 'muted')));
      const controls = el('div', '', 'row-actions');
      if (!p.active && !p.busy && !p.candidate && !needsCleanup(p)) controls.append(button('Run again', () => {
        const dialog = el('dialog');
        dialog.setAttribute('aria-labelledby', 'rerun-title');
        dialog.setAttribute('aria-describedby', 'rerun-hint');
        const title = el('h2', 'Run ' + name + ' again?'); title.id = 'rerun-title';
        const hint = el('p', 'Starts the preview and its dependencies. Previous writes remain; running this job again may duplicate data.', 'muted'); hint.id = 'rerun-hint';
        const actions = el('div', '', 'actions');
        const cancel = button('Cancel', () => dialog.close()); cancel.autofocus = true;
        actions.append(cancel, button('Run and start preview', () => {
          dialog.close();
          void mutate({ action: 'rerunJob', owner: entry.owner.id, name: p.name, attemptId: attempt.id, job: name }, 'Job rerun and startup requested.');
        }, 'primary'));
        dialog.append(title, hint, actions);
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        document.body.append(dialog); dialog.showModal();
      }, 'small', 'rerun-' + name));
      if (controls.children.length) {
        controls.firstElementChild!.setAttribute('aria-label', 'Run ' + name + ' again');
      }
      controls.append(button('Logs', () => openLogs(entry, attempt, name), 'small', 'logs-' + name));
      row.append(controls);
      list.append(row);
    }
    node.append(list);
    if (p.active && jobs.some(([, job]) => job.state === 'failed')) node.append(el('p', 'Stop the preview to rerun a job.', 'job-hint'));
  }
  function openLogs(entry: Entry, attempt: AttemptSummary, source?: string) {
    logQuery = '';
    // Focus the newly selected view immediately; a late response must never steal focus.
    void loadPanel(entry, 'logs', attempt, source);
    document.getElementById('tab-logs')?.focus({ preventScroll: true });
  }
  async function loadPanel(entry: Entry, tab: Tab, attempt?: AttemptSummary, source?: string) {
    const previous = panel.tab === tab && panel.attemptId === attempt?.id && panel.source === source ? panel : undefined;
    const current = panel = { ...previous, tab, attemptId: attempt?.id, source, error: undefined, loading: tab !== 'activity' };
    render(); if (tab === 'activity' || !attempt) return;
    try {
      const result = await call<LogResult | PreviewDescription>({ action: tab === 'logs' ? 'logs' : 'describe', owner: entry.owner.id, name: entry.name, attemptId: attempt.id, ...(tab === 'logs' && source ? { source } : {}) });
      if (panel !== current) return;
      if (tab === 'logs') panel.logs = result as LogResult; else panel.description = result as PreviewDescription;
    } catch (error) { if (panel === current) panel.error = error instanceof Error ? error.message : 'Details unavailable.'; }
    finally { if (panel === current) { panel.loading = false; render(); } }
  }
  function renderConfiguration(entry: Entry, attempt: AttemptSummary, parent: HTMLElement, description: PreviewDescription, footer: HTMLElement) {
    parent.append(el('p', 'Read-only configuration. Stored values are not included.', 'muted'));
    const env = section('Environment variables', parent); const rows = el('div', '', 'row-list');
    const bindingKeys = new Set([...description.envKeys, ...(description.secrets ?? []).flatMap(secret => secret.bindings.map(binding => (binding.service ? binding.service + '.' : '') + binding.key))]);
    for (const key of bindingKeys) {
      const secret = description.secrets?.find(s => s.bindings.some(b => (b.service ? b.service + '.' : '') + b.key === key));
      const [service, envKey] = key.split('.');
      const binding = description.spec.type === 'environment' ? description.spec.services[service]?.bindings?.[envKey] : undefined;
      const kind = secret ? 'Secret' : binding ? Object.keys(binding)[0] : 'Literal';
      const value = secret ? secret.id + (secret.selected ? ' · approved for this owner' : ' · approval required') : binding ? String(Object.values(binding)[0]) : 'Not included';
      const row = el('div', '', 'env-row'); row.append(el('code', key), el('span', kind, 'muted'), el('span', value, 'machine muted')); rows.append(row);
    }
    if (!rows.children.length) rows.append(el('p', 'No environment variables declared.', 'empty-list')); env.append(rows);
    if (entry.owner.configuration) parent.append(el('p', 'preview.yml exists. This view shows the selected runtime attempt.', 'muted'));
    const definitions = section('Service definitions', parent); const spec = description.spec;
    if (spec.type === 'environment') {
      const list = el('div', '', 'row-list');
      for (const [name, service] of Object.entries(spec.services)) {
        const row = el('div', '', 'definition-row'); row.append(el('strong', name), el('span', service.type, 'machine muted'));
        if (service.command) row.append(el('pre', JSON.stringify(service.command)));
        if (service.dependsOn?.length) row.append(el('p', 'After: ' + service.dependsOn.join(', '), 'muted'));
        if (service.run) row.append(el('p', service.run === 'once' ? 'Once per retained environment; explicit rerun required after failure.' : 'Runs on every start and replacement.', 'muted'));
        if (service.cwd || service.directory) row.append(pathText(service.cwd ?? service.directory!));
        list.append(row);
      }
      definitions.append(list);
    }
    const raw = el('details'); raw.dataset.disclosure = 'configuration'; raw.append(el('summary', 'Full requested configuration'), el('pre', JSON.stringify(spec, null, 2), 'configuration')); definitions.append(raw);
    const save = el('div', '', 'save-row'); save.append(el('p', 'Save this attempt as preview.yml. Existing files are never overwritten.'), button('Save as preview.yml', () => {
      void mutate<{ file: string; externalSources: string[] }>({ action: 'saveConfiguration', owner: entry.owner.id, name: entry.name, attemptId: attempt.id }, result => `Saved ${result.file}. The running preview is unchanged.` + (result.externalSources.length ? ' Sources outside this project keep absolute paths: ' + result.externalSources.join(', ') : ''));
    })); footer.append(save);
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
    const panelNode = el('div', '', 'tab-content'); panelNode.id = 'tab-content'; panelNode.setAttribute('role', 'tabpanel'); panelNode.setAttribute('aria-labelledby', 'tab-' + panel.tab);
    panelNode.setAttribute('aria-busy', String(!!panel.loading));
    const content = el('div', '', 'tab-body'); content.tabIndex = 0; content.dataset.scroll = 'panel-' + panel.tab; content.dataset.focus = content.dataset.scroll;
    panelNode.append(content); node.append(tabs, panelNode); detail.append(node);
    if (panel.tab === 'activity') {
      renderActivity(entry, content);
      const history = section('Recent attempts', content);
      for (const attempt of retained) {
        const row = el('div', '', 'activity-row'); row.append(el('time', new Date(attempt.startedAt).toLocaleTimeString(), 'machine muted'));
        const text = el('div'); text.append(el('strong', attempt.id === p?.active?.id ? 'Serving now' : 'Attempt ' + attempt.state), el('code', attempt.id, 'attempt-id'), el('p', attempt.error?.message ?? (attempt.readyAt ? 'Startup checks passed at ' + new Date(attempt.readyAt).toLocaleTimeString() : 'Started at the time shown.'), attempt.error ? 'error' : 'muted')); row.append(text); history.append(row);
      }
      if (!retained.length) history.append(el('p', 'No retained attempts. Start through your agent or CLI.', 'muted'));
      if (p?.cleanup?.length || p?.data?.cleanup) {
        const cleanup = message('Cleanup needs attention', deletionNeedsRetry(p) ? 'Database credential removal is incomplete.' : 'Keep these source directories until cleanup succeeds.', 'error', content);
        for (const item of p.cleanup ?? []) cleanup.append(el('p', item.error.message), ...item.sources.map(pathText));
        if (p.data?.cleanup) cleanup.append(el('p', p.data.cleanup.message));
      }
      renderRequests(entry, content, new Set(actions(entry).map(a => a.label))); return;
    }
    if (!selected) { content.append(el('p', 'The retained attempt is no longer available.', 'muted')); return; }
    const choose = el('div', '', 'attempt-picker'); choose.append(el('span', 'Attempt'));
    const selectAttempt = el('select'); selectAttempt.setAttribute('aria-label', 'Diagnostic attempt'); selectAttempt.dataset.focus = 'diagnostic-attempt';
    for (const attempt of retained) {
      const option = el('option', (attempt.id === p?.active?.id ? 'Serving' : attempt.id === p?.candidate?.id ? 'Starting' : 'Latest') + ' · ' + attempt.id.slice(0, 8));
      option.value = attempt.id; option.selected = attempt.id === selected.id; selectAttempt.append(option);
    }
    selectAttempt.addEventListener('change', () => { void loadPanel(entry, panel.tab, retained.find(a => a.id === selectAttempt.value)); });
    choose.append(selectAttempt);
    if (panel.tab === 'logs') {
      const sources = el('select'); sources.setAttribute('aria-label', 'Log source'); sources.dataset.focus = 'log-source';
      const all = el('option', 'All output'); all.value = ''; sources.append(all);
      const names = selected.type === 'environment' ? Object.keys(selected.services ?? {}) : [p!.name];
      for (const name of names) {
        const option = el('option', name); option.value = name; option.selected = panel.source === name; sources.append(option);
      }
      sources.addEventListener('change', () => { void loadPanel(entry, 'logs', selected, sources.value || undefined); });
      choose.append(sources);
    }
    const refreshPanel = button(panel.loading ? 'Refreshing…' : 'Refresh', () => { void loadPanel(entry, panel.tab, selected, panel.source); }, 'small', 'refresh-panel');
    refreshPanel.disabled ||= !!panel.loading; choose.append(refreshPanel); panelNode.prepend(choose);
    if (panel.tab === 'logs') renderLogs(!panel.error && panel.attemptId === selected.id ? panel.logs : undefined, choose, content);
    if (panel.loading && !panel.logs && !panel.description) { content.append(el('p', 'Loading…', 'muted')); return; }
    if (panel.error) { message('Details unavailable', panel.error, 'error', content); return; }
    if (panel.attemptId !== selected.id) { content.append(el('p', 'The selected attempt changed. Refresh to load its details.', 'muted')); return; }
    if (panel.tab === 'configuration' && panel.description) renderConfiguration(entry, selected, content, panel.description, panelNode);
  }
  function renderLogs(logs: LogResult | undefined, toolbar: HTMLElement, content: HTMLElement) {
    toolbar.classList.add('logs-toolbar');
    const field = el('div', '', 'log-search');
    const input = el('input'); input.type = 'search'; input.placeholder = 'Search logs…'; input.value = logQuery;
    input.setAttribute('aria-label', 'Search logs'); input.setAttribute('aria-describedby', 'log-search-summary');
    input.autocomplete = 'off'; input.spellcheck = false; input.dataset.focus = 'log-search';
    const clear = button('Clear', () => { input.value = ''; update(true); input.focus(); }, 'small', 'clear-log-search');
    clear.setAttribute('aria-label', 'Clear log search'); clear.hidden = !logQuery;
    input.disabled = clear.disabled = !logs;
    field.append(input, clear); toolbar.prepend(field);
    const summary = el('p', '', 'log-note'); summary.id = 'log-search-summary'; summary.setAttribute('role', 'status');
    toolbar.append(summary);
    if (!logs) return;
    const captured = logs;
    const output = el('pre', '', 'logs'); content.append(output);
    function update(resetScroll = false) {
      logQuery = input.value; clear.hidden = !logQuery;
      // Search only the owner's bounded, already-redacted output; keep original line order.
      const query = logQuery.toLowerCase();
      const matches = query ? captured.text.split('\n').filter(line => line.toLowerCase().includes(query)) : [];
      output.textContent = logQuery ? matches.join('\n') || 'No matching lines in captured output.' : captured.text || 'No output captured.';
      summary.textContent = (logQuery ? `${matches.length} matching ${matches.length === 1 ? 'line' : 'lines'}` : 'Captured output') +
        (captured.truncated ? ' · Earlier output omitted' : '');
      if (resetScroll) { content.scrollTop = 0; content.scrollLeft = 0; }
    }
    input.addEventListener('input', () => update(true));
    input.addEventListener('keydown', event => { if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; update(true); } });
    update();
  }
  const editDialog = document.querySelector<HTMLDialogElement>('#secret-edit')!;
  const editForm = document.querySelector<HTMLFormElement>('#secret-edit-form')!;
  const editValue = document.querySelector<HTMLTextAreaElement>('#secret-value')!;
  const editError = document.querySelector<HTMLElement>('#secret-edit-error')!;
  let editingId = '';
  let savingSecret = false;
  function openSecretEdit(id: string) {
    announce(''); editingId = id; editValue.value = ''; editError.hidden = true;
    document.querySelector('#secret-edit-name')!.textContent = id;
    editDialog.showModal(); editValue.focus();
  }
  function closeSecretEdit() {
    if (savingSecret) return;
    editValue.value = ''; editingId = ''; editDialog.close();
  }
  document.querySelector('#secret-edit-cancel')!.addEventListener('click', closeSecretEdit);
  editDialog.addEventListener('cancel', event => { event.preventDefault(); closeSecretEdit(); });
  window.addEventListener('pagehide', () => { editValue.value = ''; editingId = ''; editDialog.close(); });
  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (savingSecret) return;
    if (!editValue.value.length || editValue.value.includes('\0') || new TextEncoder().encode(editValue.value).length > 4096) {
      editError.textContent = 'Enter 1–4096 UTF-8 bytes without NUL.'; editError.hidden = false; editValue.focus(); return;
    }
    savingSecret = true; editError.hidden = true;
    const controls = editForm.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button,textarea');
    controls.forEach(control => { control.disabled = true; });
    const save = document.querySelector<HTMLButtonElement>('#secret-edit-save')!; save.textContent = 'Saving…';
    const input = { action: 'updateSecret', id: editingId, value: editValue.value };
    editValue.value = '';
    let saved = false;
    try {
      await call(input); saved = true;
      announce('Secret updated. Future starts use the new value; running apps are unchanged.');
    } catch (error) {
      editError.textContent = error instanceof Error && error.cause ? error.message :
        'The save could not be confirmed. It may have completed. Enter your intended value to retry.';
      editError.hidden = false;
    } finally {
      input.value = ''; savingSecret = false; save.textContent = 'Save';
      controls.forEach(control => { control.disabled = false; });
      if (saved) closeSecretEdit(); else editValue.focus();
    }
  });
  function renderSecretManager() {
    detail.append(el('h1', 'Secret Manager'), el('p', 'Stored Keychain references. Values are never shown.', 'summary'));
    detail.append(el('p', 'Changes apply on the next start in every project using the reference.', 'hint'));
    if (secretError) { message('Secrets unavailable', secretError + ' Use Refresh to try again.', 'error'); return; }
    if (!secretList) { detail.append(el('p', 'Loading secret references…', 'empty')); return; }
    if (!secretList.ids.length) {
      const empty = el('div', '', 'empty');
      empty.append(el('h2', 'No stored secrets'), el('p', 'Ask your agent to preview an application. When it needs a secret, enter the value in private setup. Its reference will appear here.'));
      detail.append(empty); return;
    }
    const group = section('Stored references');
    if (secretList.truncated) group.append(el('p', 'Showing the first 128 references returned by Keychain. Additional entries are not listed.', 'warning'));
    const ids = secretList.ids.filter(id => id.toLowerCase().includes(search.value.trim().toLowerCase()));
    if (!ids.length) { group.append(el('p', 'No matching references.', 'empty')); return; }
    const rows = scrollList('Stored references'); rows.classList.add('secret-list');
    for (const id of ids) {
      const row = el('div', '', 'secret-row');
      const edit = button('Edit', () => openSecretEdit(id), '', 'edit-' + id);
      edit.setAttribute('aria-label', 'Edit ' + id);
      row.append(el('code', id), edit); rows.append(row);
    }
    group.append(rows);
  }
  function renderActivity(entry: Entry, parent: HTMLElement) {
    const { owner, preview: p } = entry;
    const availableActions = actions(entry); const taken = new Set(availableActions.map(a => a.label));
    const addNotice = (heading: string, body: string, tone = '', extra?: Action) => {
      const node = message(heading, body, tone, parent);
      if (extra && !taken.has(extra.label)) { node.append(button(extra.label, extra.run)); taken.add(extra.label); }
    };
    if (deletionNeedsRetry(p)) addNotice('Data reset incomplete', 'Managed data was deleted, but its database credential could not be removed. Resolve the Keychain error, then choose Reset data to finish and start again.', 'error');
    else if (needsCleanup(p)) addNotice('Cleanup needs attention', 'Some owned resources could not be confirmed stopped. Inspect the details before retrying cleanup.', 'error');
    else if (pending(entry).length) addNotice('Private setup requested', 'Approve access and enter any missing values in the separate private form. Cancellation stays in that form.', 'warning');
    else if (!p?.candidate && p?.latest?.state === 'failed' && !Object.values(p.latest.services ?? {}).some(service => service.type === 'job' && service.state === 'failed')) addNotice(p.active ? 'The update failed. Your previous version is still running.' : 'Startup failed. Your app is not running.', p.latest.error?.message ?? 'Review the latest attempt for details.', 'error', { label: 'View error log', run: () => openLogs(entry, p.latest!) });
    else if (!p?.candidate && p?.latest?.state === 'canceled') addNotice(p.active ? 'The update was canceled. Your previous version is still running.' : 'Startup was canceled.', 'Nothing was started again automatically. Ask your agent to continue only when you are ready.');
    if (owner.legacy) addNotice('Owner update needed', 'This owner runs an older build. New controls require an explicit owner upgrade; this page will not restart it.');
    if (!p?.active || p.candidate || needsCleanup(p)) parent.append(el('p', hint(entry), 'activity-hint'));
    if (p) { renderAttempts(p, parent); renderServices(entry, parent); renderJobs(entry, parent); }
    if (owner.configuration?.error) message('preview.yml needs attention', owner.configuration.error.message + (p?.active ? ' The running app is unchanged.' : ''), 'error', parent);
    if (owner.legacy && p?.active) message('Stop through the CLI', `Run previewhost stop ${p.name} from this project.`, '', parent);
  }
  function renderDetail() {
    detail.replaceChildren(); detail.classList.remove('overview', 'preview-detail');
    document.querySelector('#crumb')!.textContent = secretManager ? 'Secret Manager' : selection ? 'Preview details' : 'All previews';
    if (secretManager) { renderSecretManager(); return; }
    if (!selection) { renderOverview(); return; }
    const owner = owners.find(o => o.id === selection!.owner);
    if (!owner) { message('Project no longer listed', 'Its owner may have shut down. Start through your agent or CLI to reconnect.'); return; }
    const entry: Entry = { owner, name: selection.name, preview: owner.previews?.find(p => p.name === selection!.name) };
    const p = entry.preview; const status = state(entry);
    const header = el('div', '', 'preview-header'); const identity = el('div', '', 'preview-identity');
    const title = el('div', '', 'preview-title'); title.append(el('h1', entry.name ?? shortProject(owner)));
    title.append(el('span', owner.error ? 'Unavailable' : status.label, 'status ' + (owner.error ? 'error' : status.tone)));
    identity.append(title);
    if (owner.project) { const path = el('div', '', 'identity-path'); path.append(pathText(owner.project), copy(owner.project)); identity.append(path); }
    if (p?.active && (p.latest?.state === 'failed' || p.candidate)) identity.append(el('p', 'Previous version serving', 'context-note'));
    else if (owner.configuration?.error) identity.append(el('p', 'preview.yml needs attention', 'context-note warning'));
    const row = el('div', '', 'header-actions');
    const canOpen = !!(p?.active && p.url); let primaryTaken = canOpen;
    if (canOpen) row.append(urlLink(p!.url!, 'Open app', 'button primary'), copy(p!.url!, 'Copy URL'));
    for (const action of actions(entry)) {
      const primary = !primaryTaken && !action.danger; if (primary) primaryTaken = true;
      row.append(button(action.label, action.run, primary ? 'primary' : action.danger ? 'danger' : ''));
    }
    header.append(identity, row); detail.append(header);
    if (owner.error) { message('Status unavailable', owner.error.message + ' Other projects remain available.', 'error'); return; }
    detail.classList.add('preview-detail'); renderTabs(entry);
  }
  function render() {
    const active = document.activeElement;
    const focus = (active as HTMLElement)?.dataset.focus;
    const selectionRange = active instanceof HTMLInputElement && active.selectionStart !== null ? [active.selectionStart, active.selectionEnd!] : undefined;
    // Renders replace DOM nodes, but background refreshes must not move the reader.
    const scroll = [...document.querySelectorAll<HTMLElement>('#main, #projects, [data-scroll]')]
      .map(node => ({ key: node.dataset.scroll ?? node.id, top: node.scrollTop, left: node.scrollLeft }));
    const expanded = [...detail.querySelectorAll<HTMLDetailsElement>('details[data-disclosure][open]')].map(node => node.dataset.disclosure);
    document.body.classList.toggle('show-secrets', secretManager);
    renderList(); renderDetail(); updateElapsed();
    for (const node of detail.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) node.open = expanded.includes(node.dataset.disclosure);
    for (const node of document.querySelectorAll<HTMLElement>('#main, #projects, [data-scroll]')) {
      const previous = scroll.find(item => item.key === (node.dataset.scroll ?? node.id));
      if (previous) { node.scrollTop = previous.top; node.scrollLeft = previous.left; }
    }
    if (focus) {
      const target = document.querySelector<HTMLElement>('[data-focus="' + CSS.escape(focus) + '"]');
      target?.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement && selectionRange) target.setSelectionRange(selectionRange[0], selectionRange[1]);
    }
  }
  function updateElapsed() {
    for (const node of document.querySelectorAll<HTMLElement>('[data-elapsed]')) node.textContent = Math.max(0, Math.floor((Date.now() - Date.parse(node.dataset.elapsed!)) / 1000)) + 's elapsed';
  }
  async function refresh() {
    if (loading || document.hidden || editDialog.open) return;
    loading = true;
    const showingSecrets = secretManager;
    try {
      if (showingSecrets) {
        const result = await call<{ ids: string[]; truncated: boolean }>({ action: 'listSecrets' });
        connection.textContent = 'Running locally';
        if (connectionNotice) announce('');
        const next = JSON.stringify(result);
        if (secretError || next !== snapshot || !secretList) {
          secretList = result; secretError = undefined; snapshot = next;
          if (secretManager) render();
        }
        return;
      }
      const result = await call<Owner[]>({ action: 'list' }); connection.textContent = 'Running locally';
      if (connectionNotice) announce('');
      const next = JSON.stringify(result); if (next !== snapshot) { owners = result; snapshot = next; render(); }
      updateElapsed();
    } catch (error) {
      if (showingSecrets && capability) {
        secretList = undefined; secretError = error instanceof Error ? error.message : 'Keychain could not be reached.';
        if (secretManager) render();
        return;
      }
      connection.textContent = 'Disconnected';
      announce(capability ? 'Dashboard disconnected. Your previews may still be running. Run previewhost dashboard to reopen it.' : 'Run previewhost dashboard to open an authenticated session. This tab has no usable private session.', true);
      if (!capability) { document.body.classList.add('show-detail'); detail.replaceChildren(el('h1', 'Open from your terminal'), el('pre', 'previewhost dashboard'), el('p', 'The launcher opens a private local session. No account is needed.', 'muted')); }
      else if (error instanceof Error && error.message.includes('too large')) announce(error.message);
    } finally { loading = false; }
  }
  search.addEventListener('input', render);
  document.querySelector('#home')!.addEventListener('click', () => select());
  document.querySelector('#overview')!.addEventListener('click', () => select());
  document.querySelector('#secret-manager')!.addEventListener('click', () => {
    announce(''); secretManager = true; selection = undefined; search.value = '';
    document.body.classList.add('show-detail'); render(); void refresh();
    for (const node of document.querySelectorAll('#main, .tab-body')) { node.scrollTop = 0; node.scrollLeft = 0; }
    const heading = detail.querySelector('h1'); if (heading) { heading.tabIndex = -1; heading.focus(); }
  });
  document.querySelector('#refresh')!.addEventListener('click', () => { snapshot = ''; void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh(); setInterval(() => { if (capability) void refresh(); }, 2500);
}

export const dashboardScript = themeScript + `(${mountDashboard.toString()})();`;
export const dashboardStyle = uiStyle + `
#connection { margin-left:auto; color:var(--t5); font-size:12.5px; }
body { height:100dvh; display:flex; flex-direction:column; }
#notice { padding:10px 20px; border-bottom:1px solid var(--border); background:var(--subtle); color:var(--t3); font-size:13px; }
.workspace { display:grid; grid-template-columns:220px minmax(0,1fr); flex:1; min-height:0; }
aside { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--border); }
.search { display:block; padding:14px 14px 10px; }
input { width:100%; height:32px; padding:0 11px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--t1); font-size:13px; }
input::placeholder { color:var(--t5); }
.nav-overview { margin:0 10px 8px; justify-content:space-between; border:0; height:34px; padding:0 9px; }
.nav-overview[aria-current=true] { background:var(--sel); }
#preview-count { color:var(--t5); font-family:'Geist Mono',monospace; font-size:11.5px; }
#projects { flex:1; min-height:0; overflow-y:auto; padding:4px 10px 16px; }
.project { margin-bottom:8px; }
.project>.section-label { margin:0; padding:6px 8px 5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.preview-row { display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:8px; row-gap:1px; height:auto; width:100%; padding:7px 9px; border:0; margin-top:1px; white-space:normal; text-align:left; }
.preview-row:hover,.nav-overview:hover { background:var(--hover); }
.preview-row[aria-current=true] { background:var(--sel); }
.nav-identity { display:contents; }
.nav-identity strong { display:block; min-width:0; grid-column:1; grid-row:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13.5px; font-weight:500; }
.nav-identity .path { grid-column:1/-1; grid-row:2; font-size:11px; margin-top:1px; }
.nav-identity .path-tail { display:flex; min-width:0; max-width:100%; color:var(--t4); }
.path-directory { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.path-folder { flex-shrink:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; }
.nav-identity .path-parent { display:none; }
.preview-row>.status { grid-column:2; grid-row:1; font-size:11.5px; }
.preview-row>.ready,.preview-row>.muted { color:var(--t5); font-weight:400; }
.scope { border-top:1px solid var(--border); margin:0; padding:12px 16px; font-size:12px; color:var(--t5); line-height:1.45; }
#main { min-width:0; min-height:0; overflow-y:auto; scrollbar-gutter:stable; scroll-padding-top:16px; }
#detail { padding:24px; }
#detail.preview-detail { height:100%; min-height:0; padding:0; display:flex; flex-direction:column; }
#main:has(.preview-detail) { overflow:hidden; }
.preview-header { display:flex; align-items:flex-start; gap:24px; padding:16px 24px 8px; flex:none; }
.preview-identity { flex:1; min-width:0; }
.preview-title { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 16px; }
.preview-title h1 { min-width:0; font-size:22px; line-height:1.3; letter-spacing:-.5px; margin:0; }
.preview-title .status { flex:none; }
.identity-path { display:flex; align-items:center; gap:8px; margin-top:4px; }
.identity-path .path { min-width:0; font-size:12px; }
.identity-path .path-tail { display:flex; flex:none; min-width:0; max-width:100%; }
.identity-path button { height:24px; padding:0 6px; border-color:transparent; color:var(--t4); }
.header-actions { display:flex; align-items:center; gap:8px; flex:none; }
.header-actions button,.header-actions .button { height:32px; }
.context-note { color:var(--t4); font-size:12px; margin:4px 0 0; }
.activity-hint { color:var(--t4); margin:0 0 16px; font-size:13px; }
.overview>h1 { font-size:26px; letter-spacing:-.6px; }
.hint { margin:0; padding-bottom:20px; border-bottom:1px solid var(--border); color:var(--t4); font-size:13px; line-height:1.6; }
.section { padding:20px 0; border-bottom:1px solid var(--border); }
.section>.section-label { margin-bottom:12px; }
.section>.path { margin-top:10px; }
.section>p { font-size:12.5px; }
.attempt-line { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; padding:18px 0; border-bottom:1px solid var(--border); }
.attempt-line>.section-label { width:110px; }
.attempt-id { font-size:12px; overflow-wrap:anywhere; }
.attempt-split { margin:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.attempt-split>div { padding:16px 18px; min-width:0; }
.attempt-split>div+div { border-left:1px solid var(--border); }
.attempt-split .attempt-id { display:block; margin:6px 0; }
.attempt-split p { margin:0; font-size:12.5px; color:var(--t4); }
.row-list { border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.scroll-list { max-height:360px; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
.show-secrets #detail { height:100%; display:flex; flex-direction:column; }
.show-secrets #detail>h1,.show-secrets .summary,.show-secrets .hint { flex:none; }
.show-secrets .summary { margin-bottom:8px; }
.show-secrets #detail>.section { flex:1; min-height:180px; display:flex; flex-direction:column; border:0; padding-bottom:0; }
.show-secrets .section>h2,.show-secrets .section>p { flex:none; }
.secret-list { flex:0 1 auto; min-height:0; max-height:520px; }
.row-list>div+div { border-top:1px solid var(--divider); }
dialog { width:min(520px,calc(100% - 32px)); max-height:calc(100dvh - 32px); overflow:auto; padding:26px; border:1px solid var(--border-2); border-radius:9px; background:var(--bg); color:var(--t1); }
dialog::backdrop { background:var(--bg); opacity:.72; }
dialog h2 { font-size:22px; margin-bottom:8px; }
#secret-edit-name { overflow-wrap:anywhere; color:var(--t2); margin-bottom:18px; }
#secret-edit-hint { color:var(--t4); font-size:13px; margin-bottom:22px; }
#secret-edit label { display:block; font-weight:500; margin-bottom:8px; }
#secret-value { width:100%; min-height:100px; padding:12px; border:1px solid var(--border-2); border-radius:6px; resize:vertical; background:var(--subtle); color:var(--t1); -webkit-text-security:disc; }
dialog .muted,#secret-edit-error { font-size:12.5px; margin-top:10px; overflow-wrap:anywhere; }
dialog .actions { justify-content:flex-end; padding:0; margin-top:24px; }
.secret-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:20px; padding:9px 16px; }
.secret-row code { overflow-wrap:anywhere; color:var(--t2); }
.service-row { display:grid; grid-template-columns:144px 96px 88px minmax(0,1fr) 112px; align-items:center; gap:12px; padding:12px 16px; }
.service-row>strong { overflow-wrap:anywhere; font-size:13.5px; }
.service-row .status { font-size:12.5px; }
.service-row .ready { font-weight:400; }
.service-row.managed { background:var(--subtle); }
.service-meta { text-align:right; font-size:12px; }
.service-error { grid-column:1/-1; margin:0; font-size:12.5px; }
.source-folders { margin:12px 0 0; }
.source-folders .path { margin-top:8px; }
.section-heading { display:flex; align-items:center; gap:16px; margin-bottom:12px; }
.section-heading h2 { margin:0 auto 0 0; }
.section-heading>.muted { font-size:12px; }
.job-row { display:grid; grid-template-columns:minmax(0,1fr) 88px auto; align-items:center; gap:16px; padding:14px 16px; }
.job-identity { min-width:0; }
.job-identity strong { font-size:13.5px; overflow-wrap:anywhere; }
.job-note { margin:4px 0 0; font-size:12.5px; color:var(--t4); overflow-wrap:anywhere; }
.job-hint { margin:10px 0 0; color:var(--t4); }
.job-row>.status { font-size:12.5px; font-weight:400; }

.summary { color:var(--t4); margin:6px 0 26px; }
.overview-row { display:grid; grid-template-columns:minmax(0,1fr) 160px 164px; align-items:center; gap:20px; padding:14px 16px; }
.row-identity { min-width:0; }
.row-identity>.path { font-size:11.5px; margin-top:2px; }
.row-identity .path-tail { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.overview-state { font-size:13px; }
.overview-state small { display:block; font-size:12px; color:var(--t5); margin-top:2px; }
.row-actions { display:flex; justify-content:flex-end; gap:8px; }
.row-actions button,.row-actions .button { height:30px; padding:0 12px; }
.tabs-section { display:flex; flex-direction:column; flex:1; min-height:0; }
.tabs { display:flex; align-items:center; gap:24px; flex:none; height:44px; padding:0 24px; border-bottom:1px solid var(--border); }
.tabs button { border:0; border-radius:0; padding:0; height:44px; color:var(--t4); background:none; font-weight:400; }
.tabs button[aria-selected=true] { border-bottom:2px solid var(--t1); color:var(--t1); font-weight:500; }
.tab-content { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
.tab-body { flex:1; min-height:0; min-width:0; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding:20px 24px; }
.tab-body:has(.logs) { padding:0; background:var(--subtle); }
.tab-body>.section:last-child { border-bottom:0; }
.tab-body>.notice { margin-bottom:0; }
.tab-content>.save-row { flex:none; border:0; border-top:1px solid var(--border); border-radius:0; padding:8px 24px; background:var(--bg); }
.activity-row { display:flex; align-items:baseline; gap:16px; padding:12px 0; }
.activity-row+.activity-row { border-top:1px solid var(--divider-2); }
.activity-row time { width:90px; flex:none; font-size:12px; }
.activity-row>div { min-width:0; }
.activity-row code { display:block; margin:3px 0; }
.activity-row p { margin:0; font-size:12.5px; }
.reset-row { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:16px; }
.reset-row p { margin:0; font-size:12.5px; }
.reset-resources { padding-left:20px; margin:16px 0; }
.attempt-picker { display:flex; flex:none; flex-wrap:wrap; gap:10px; align-items:center; padding:8px 24px; margin:0; border-bottom:1px solid var(--border); color:var(--t4); font-size:12.5px; }
.attempt-picker [data-focus=refresh-panel] { min-width:94px; height:32px; }
select { min-width:0; max-width:100%; height:32px; padding:0 8px; border:1px solid var(--border-2); border-radius:6px; background:var(--bg); color:var(--t2); font-family:'Geist Mono',monospace; font-size:12px; }
.logs,.configuration { background:var(--subtle); padding:16px 24px; white-space:pre; line-height:1.9; font-size:12px; color:var(--t3); }
.logs { margin:0; min-height:100%; width:max-content; min-width:100%; }
.configuration { border:1px solid var(--border); border-radius:8px; overflow-x:auto; }
.log-search { display:flex; align-items:center; flex:1; min-width:180px; height:32px; border:1px solid var(--border-2); border-radius:6px; background:var(--subtle); }
.log-search:focus-within { outline:2px solid var(--t2); outline-offset:2px; }
.log-search input { min-width:0; border:0; background:none; outline:none; }
.log-search input::-webkit-search-cancel-button { display:none; }
.log-search button { height:24px; margin-right:4px; border:0; background:none; color:var(--t4); }
.logs-toolbar>span { display:none; }
.log-note { margin:0 0 0 auto; font-size:12px; color:var(--t4); }
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
  .overview-row>.row-actions { grid-column:1/-1; }
  .service-row { grid-template-columns:80px 76px 72px minmax(0,1fr) 112px; gap:8px; padding:12px; }
}
@media (max-width:760px) {
  header { padding:0 14px; gap:10px; }
  #crumb,#connection,header>.slash { display:none; }
  header .brand { margin-right:auto; }
  .workspace { display:flex; flex-direction:column; }
  aside { display:grid; grid-template-columns:1fr 1fr; border-right:0; flex:none; border-bottom:1px solid var(--border); padding:8px 12px; gap:4px; }
  aside .search { grid-column:1/-1; padding:0 0 4px; }
  .nav-overview,.show-detail .nav-overview { margin:0; height:34px; }
  .scope { display:none; }
  #projects { display:none; }
  .show-detail:not(.show-secrets) aside .search { display:none; }
  #main { flex:1; }
  #detail { padding:20px 16px; }
  .preview-header { padding:16px 16px 8px; flex-direction:column; gap:10px; }
  .preview-identity { width:100%; }
  .preview-title { gap:12px; }
  .preview-title h1 { font-size:20px; }
  .preview-title .status { font-size:12px; }
  .header-actions { flex-wrap:wrap; max-width:100%; }
  .header-actions button,.header-actions .button { height:30px; }
  .tabs { padding:0 16px; }
  .tab-body { padding:16px; }
  .attempt-picker { padding:10px 16px; }
  .tab-content>.save-row { padding:10px 16px; }
  .logs-toolbar { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  .log-search { grid-column:1/-1; min-width:0; }
  .logs-toolbar [data-focus=refresh-panel] { justify-self:start; }
  .log-note { margin:0; font-size:11px; text-align:right; }
  h1 { font-size:26px; }
  .section>.path,.definition-row>.path,.source-folders>.path { flex-wrap:wrap; }
  .section>.path .path-tail,.definition-row>.path .path-tail,.source-folders .path-tail { white-space:normal; overflow-wrap:anywhere; flex-shrink:1; }
  .attempt-split { grid-template-columns:1fr; }
  .attempt-split>div+div { border-left:0; border-top:1px solid var(--border); }
  .overview-row { grid-template-columns:minmax(0,1fr) 130px; gap:10px; padding:12px; }
  .overview-state .status { font-size:12px; }
  .overview-state small { font-size:11px; }
  .job-row { grid-template-columns:minmax(0,1fr) auto; gap:10px 16px; }
  .job-row .row-actions { grid-column:1/-1; }
  .section-heading { flex-wrap:wrap; gap:10px; }
  .service-row { grid-template-columns:minmax(0,1fr) 76px 88px; }
  .service-meta { grid-column:1; grid-row:auto; text-align:left; }
  .service-action { grid-column:2/-1; }
  .service-row>.status { text-align:right; }
  .env-row { grid-template-columns:minmax(0,1fr) 90px; }
  .env-row>:last-child { grid-column:1/-1; }
  .attempt-picker { flex-wrap:wrap; }
  .attempt-picker select { flex:1; }
  .attempt-picker>span { display:none; }
  .tab-content>.save-row { gap:8px; }
  .tab-content>.save-row p { min-width:100%; font-size:12px; }
  .tab-content>.save-row button { margin-left:auto; }
  .reset-row { align-items:flex-start; }
  .secret-row { gap:12px; padding:12px; }
  .activity-row { flex-wrap:wrap; gap:4px; }
  .activity-row>div { width:100%; }
}
`;
