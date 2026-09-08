// Fixed first-party assets. Request labels are inserted as text by the script.
export const secretsPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>previewd · Secrets</title><link rel="stylesheet" href="/secrets.css"><script src="/secrets.js" defer></script></head>
<body><main><p class="brand">previewd</p><h1 id="title">Private secret setup</h1>
<p id="message" role="status" aria-live="polite">Loading this request…</p>
<dl id="context"></dl><form id="form" hidden autocomplete="off"><div id="fields"></div>
<label class="reveal"><input type="checkbox" id="reveal"> Show values</label>
<p>Save stores these entries in macOS Keychain. It does not start an application.</p>
<div class="actions"><button type="submit">Save</button><button type="button" id="cancel">Cancel</button></div></form>
<p id="result" tabindex="-1"></p></main></body></html>`;

export const secretsStyle = `:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;color:light-dark(#202420,#ebeee9);background:light-dark(#f6f7f3,#181b19)}
*{box-sizing:border-box}body{margin:0}main{max-width:660px;margin:7vh auto;padding:28px}h1{font-size:1.75rem;line-height:1.2;margin:12px 0 20px}.brand{font-size:.9rem;font-weight:700;letter-spacing:.04em}p{color:light-dark(#51594f,#bbc4b7)}
dl{margin:28px 0;overflow-wrap:anywhere}dt{font-size:.8rem;color:light-dark(#60695e,#a9b2a5);margin-top:16px}dd{margin:4px 0}label{display:block;font-weight:600}.recipient{display:block;font-size:.85rem;font-weight:400;color:light-dark(#60695e,#a9b2a5);margin:4px 0 8px;overflow-wrap:anywhere}
.field{margin:24px 0}textarea{width:100%;min-height:72px;padding:12px;font:16px/1.5 ui-monospace,monospace;border:1px solid light-dark(#9da798,#687262);border-radius:6px;background:light-dark(#fff,#21261f);color:inherit;resize:vertical;-webkit-text-security:disc}form.show textarea{-webkit-text-security:none}
.reveal{display:flex;align-items:center;gap:8px;font-size:.9rem;font-weight:400}input[type=checkbox]{width:18px;height:18px}.actions{display:flex;gap:12px;margin-top:24px}button{border:1px solid light-dark(#9da798,#687262);border-radius:6px;padding:10px 24px;font:inherit;cursor:pointer;background:transparent;color:inherit}button[type=submit]{background:light-dark(#28563b,#b5d4a5);color:light-dark(#fff,#182815);border-color:transparent}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid light-dark(#2f754a,#b5d4a5);outline-offset:3px}[hidden]{display:none!important}#result:empty{display:none}@media(max-width:480px){main{margin:16px auto;padding:20px}.actions button{flex:1}}`;

export const secretsScript = `'use strict';
(() => {
  let capability = location.hash.slice(1);
  history.replaceState(null, '', '/secrets');
  const form = document.getElementById('form');
  const fields = document.getElementById('fields');
  const message = document.getElementById('message');
  const result = document.getElementById('result');
  const controls = () => form.querySelectorAll('button,textarea,input');
  const clear = () => { fields.querySelectorAll('textarea').forEach(field => { field.value = ''; }); };
  async function call(route, body) {
    const response = await fetch('/secrets/' + route, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + capability }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error?.message || 'The request could not finish.');
    return data.result;
  }
  function finish(text) { clear(); capability = ''; form.hidden = true; result.textContent = text; result.focus(); }
  function describe(label, value) {
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd'); detail.textContent = value;
    document.getElementById('context').append(term, detail);
  }
  document.getElementById('reveal').addEventListener('change', event => form.classList.toggle('show', event.target.checked));
  document.getElementById('cancel').addEventListener('click', async () => {
    controls().forEach(control => { control.disabled = true; });
    try { await call('cancel', {}); finish('Canceled. Nothing was started.'); }
    catch (error) { finish(error.message); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.create(null);
    for (const field of fields.querySelectorAll('textarea')) {
      const value = field.value;
      if (!value.length || value.includes('\\0') || new TextEncoder().encode(value).length > 4096) {
        message.textContent = 'Each secret must contain 1–4096 UTF-8 bytes without NUL.'; field.focus(); return;
      }
      values[field.dataset.id] = value;
    }
    controls().forEach(control => { control.disabled = true; }); message.textContent = 'Saving…';
    try {
      const saved = await call('save', { values });
      message.textContent = saved.state === 'complete' ? 'Saved' : 'Some entries still need attention';
      finish(saved.state === 'complete' ? 'You can return to your client and retry the preview.' :
        (saved.error?.message || 'The save did not finish.') + ' Open a new setup request to check: ' + saved.remaining.join(', '));
    } catch (error) {
      message.textContent = 'Check the save result in your client';
      finish('The response was lost or rejected. A write may have completed. Check secret setup status before retrying. ' + error.message);
    } finally { for (const id of Object.keys(values)) delete values[id]; }
  });
  window.addEventListener('pagehide', () => { clear(); capability = ''; });
  (async () => {
    if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error('This private link is unavailable. Open a new secret setup request from your client.');
    const request = await call('form', {});
    document.getElementById('title').textContent = request.mode === 'edit' ? 'Replace a stored secret' : 'Add missing secrets';
    message.textContent = request.mode === 'edit' ? 'Replacement affects all future readers of this exact secret name. Existing values are never shown.' :
      'Only missing entries are added. An entry created elsewhere while this form is open keeps its value.';
    describe('Daemon', location.origin);
    if (request.name) describe('Preview', request.name);
    for (const source of request.sources) describe('Source directory', source);
    describe('Expires', new Date(request.expiresAt).toLocaleTimeString());
    for (const id of request.remaining) {
      const requirement = request.requirements.find(item => item.id === id);
      const wrapper = document.createElement('div'); wrapper.className = 'field';
      const label = document.createElement('label'); const field = document.createElement('textarea');
      field.id = 'secret-' + fields.children.length; field.dataset.id = id; field.required = true; field.spellcheck = false;
      field.autocomplete = 'off'; field.autocapitalize = 'off'; field.setAttribute('autocorrect', 'off');
      label.htmlFor = field.id; label.textContent = id;
      const recipients = document.createElement('span'); recipients.className = 'recipient';
      recipients.textContent = requirement.bindings.length ? 'Used here by: ' + requirement.bindings.map(item => (item.service ? item.service + ' · ' : '') + item.key).join(', ') : 'Shared entry; recipients depend on future requests.';
      wrapper.append(label, recipients, field); fields.append(wrapper);
    }
    form.hidden = false; fields.querySelector('textarea')?.focus();
  })().catch(error => { message.textContent = error.message; capability = ''; });
})();`;
