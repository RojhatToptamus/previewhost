const element = (id) => document.getElementById(id);
let configuration;
let saving = false;

async function getJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The service is unavailable.');
  return result;
}

function showError(id, message) {
  const target = element(id);
  target.textContent = message;
  target.hidden = !message;
}

async function refreshNotes() {
  try {
    const result = await getJson(new URL('/notes', configuration.apiUrl));
    element('api-revision').textContent = `API: ${result.revision}`;
    element('notes').replaceChildren(...result.notes.map((note) => {
      const item = document.createElement('li');
      const text = document.createElement('p');
      const detail = document.createElement('small');
      text.textContent = note.text;
      detail.textContent = `${note.revision} · ${new Date(note.createdAt).toLocaleString()}`;
      item.append(text, detail);
      return item;
    }));
    element('empty-notes').hidden = result.notes.length > 0;
    element('empty-notes').textContent = 'No notes yet. Add the first one.';
    element('save').disabled = saving;
    showError('api-error', '');
  } catch {
    element('api-revision').textContent = 'API: unavailable';
    element('save').disabled = true;
    element('empty-notes').hidden = true;
    showError('api-error', 'The API is unavailable. Check the environment status, then select Refresh. Existing notes stay in PostgreSQL.');
  }
}

async function refreshReport() {
  try {
    const result = await getJson(new URL('/summary', configuration.reportingUrl));
    element('reporting-revision').textContent = `Reporting: ${result.revision}`;
    element('total-notes').textContent = String(result.totalNotes);
    element('cached-note').textContent = result.cachedNote?.text ?? 'No cached note yet.';
    showError('reporting-error', '');
  } catch {
    element('reporting-revision').textContent = 'Reporting: unavailable';
    element('total-notes').textContent = '—';
    element('cached-note').textContent = 'Unavailable';
    showError('reporting-error', 'Reporting is unavailable. Check the API and database services, then select Refresh.');
  }
}

async function refresh() {
  if (!configuration) {
    try {
      configuration = await getJson('/config');
      element('frontend-revision').textContent = `Web: ${configuration.revision}`;
    } catch {
      showError('api-error', 'The preview is unavailable. Start the environment, then select Refresh.');
      return;
    }
  }
  element('refresh').disabled = true;
  await Promise.all([refreshNotes(), refreshReport()]);
  element('refresh').disabled = false;
}

element('refresh').addEventListener('click', () => { void refresh(); });
element('note-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!configuration || saving) return;
  const text = element('note').value.trim();
  if (!text) return;
  saving = true;
  element('save').disabled = true;
  element('save-status').textContent = 'Saving…';
  try {
    const result = await getJson(new URL('/notes', configuration.apiUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    element('note').value = '';
    element('save-status').textContent = result.cacheUpdated ? 'Saved in PostgreSQL and shared through Redis.' : 'Saved in PostgreSQL. The Redis cache is unavailable.';
  } catch {
    element('save-status').textContent = 'The save result is unavailable. Refresh the notes before you submit again.';
  } finally {
    saving = false;
    await refresh();
  }
});
void refresh();
