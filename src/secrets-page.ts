import { uiStyle, themeScript, brandMark } from './ui.js';

// Fixed first-party assets. Request labels are inserted as text by the script.
export const secretsPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private setup · Previewhost</title><link rel="icon" type="image/png" sizes="64x64" href="/favicon.png"><link rel="icon" type="image/svg+xml" sizes="any" href="/previewhost.svg"><link rel="stylesheet" href="/secrets.css"><script src="/secrets.js" defer></script></head>
<body><header><span class="brand"><span class="brand-icon" aria-hidden="true">${brandMark}</span>previewhost</span><span class="slash">/</span><span id="crumb">Private setup</span><button id="theme" aria-label="Switch to dark theme">Dark</button></header><main><h1 id="title">Private secret setup</h1>
<p id="message" role="status" aria-live="polite">Loading this request…</p>
<dl id="context"></dl><form id="form" hidden autocomplete="off"><div id="fields"></div>
<label class="reveal" id="reveal-label"><input type="checkbox" id="reveal"> Show values</label>
<div class="actions"><button type="submit" id="submit" class="primary hero">Save secrets</button><button type="button" id="cancel" class="hero">Cancel</button></div><p id="scope"></p></form>
<div id="result" class="notice" role="status" tabindex="-1"></div></main></body></html>`;

export const secretsStyle = uiStyle + `
header #theme { margin-left:auto; }
main { width:100%; max-width:720px; margin:0 auto; padding:40px 32px 64px; }
h1 { margin-bottom:14px; }
#message { color:var(--t3); font-size:13.5px; line-height:1.6; }
dl { margin:26px 0; border:1px solid var(--border); border-radius:8px; padding:0 16px; }
.context-row { display:grid; grid-template-columns:120px minmax(0,1fr); gap:16px; padding:12px 0; }
.context-row+.context-row { border-top:1px solid var(--divider); }
dt { color:var(--t5); font-size:12.5px; }
dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.field { padding:18px 0; }
.field+.field { border-top:1px solid var(--divider); }
label { display:block; }
.recipient { display:block; font-size:12.5px; color:var(--t4); margin:4px 0 10px; overflow-wrap:anywhere; }
input[type=password] { display:block; width:100%; margin-top:8px; padding:12px; border:1px solid var(--border-2); border-radius:6px; background:var(--bg); color:var(--t1); }
textarea { width:100%; min-height:80px; padding:12px; border:1px solid var(--border-2); border-radius:6px; background:var(--bg); color:var(--t1); resize:vertical; -webkit-text-security:disc; }
form.show textarea { -webkit-text-security:none; }
.reveal { display:flex; align-items:center; gap:8px; color:var(--t4); font-size:13px; margin:8px 0 24px; }
input[type=checkbox] { width:16px; height:16px; accent-color:var(--inv-bg); }
#scope { color:var(--t4); font-size:13px; line-height:1.6; padding-top:16px; border-top:1px solid var(--border); }
.actions { margin-top:24px; }
#result { margin-top:26px; }
#result:empty,dl:empty { display:none; }
@media(max-width:600px) {
  header { padding:0 16px; }
  main { padding:28px 20px 40px; }
  h1 { font-size:26px; }
  .context-row { grid-template-columns:1fr; gap:4px; }
  .path { flex-wrap:wrap; }
  .path-parent { flex-basis:100%; }
  .path-tail { white-space:normal; overflow-wrap:anywhere; flex-shrink:1; }
}
@media(max-width:380px) {
  header .slash,header #crumb { display:none; }
}
`;

export const secretsScript = "'use strict';" + themeScript + `
(() => {
  let capability = location.hash.slice(1);
  history.replaceState(null, '', '/secrets');
  const form = document.getElementById('form');
  const fields = document.getElementById('fields');
  const message = document.getElementById('message');
  const result = document.getElementById('result');
  let needsApproval = false;
  let editing = false;
  let store;
  const controls = () => form.querySelectorAll('button,textarea,input');
  const clear = () => { fields.querySelectorAll('textarea,input[type=password]').forEach(field => { field.value = ''; }); };
  async function call(route, body) {
    const response = await fetch('/secrets/' + route, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + capability }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error?.message || 'The request could not finish.');
    return data.result;
  }
  function finish(title, text, tone = '') {
    clear(); capability = ''; form.hidden = true;
    document.getElementById('title').textContent = title;
    message.textContent = ''; result.className = 'notice ' + tone;
    const copy = document.createElement('p'); copy.textContent = text;
    result.replaceChildren(copy); result.focus();
  }
  function completion(request) {
    if (editing) {
      finish(request.state === 'complete' ? 'Secret updated' : 'Secret update needs attention', request.state === 'complete' ?
        'Saved to the keystore. Future starts using this reference receive the new value. Running applications keep their current value. You can close this tab.' :
        (request.error?.message || 'The update did not finish.') + ' Open a new edit form when you are ready to retry.', request.state === 'complete' ? '' : 'warning');
      return;
    }
    const warning = request.keystore?.warning ? request.keystore.warning + ' ' : '';
    const saved = warning + (request.saved.length ? 'Saved: ' + request.saved.join(', ') + '. ' : '');
    const reused = request.alreadyPresent.length ? 'Reused existing entries: ' + request.alreadyPresent.join(', ') + '. Those values were kept; any input for them was not applied. ' : '';
    finish(request.state === 'complete' ? 'Secret setup complete' : 'Some entries still need attention', saved + reused + (request.state === 'complete' ?
      'No application was started. If your agent stopped waiting, return to it and send “Secrets saved—continue”.' :
      (request.error?.message || 'The request did not finish.') + ' Earlier approvals and saved values remain. Open a new setup request to recheck: ' + request.remaining.join(', ')), request.state === 'complete' ? '' : 'warning');
  }
  function describe(label, value, machine = false) {
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd');
    if (label === 'Source directory') {
      const path = document.createElement('span'); path.className = 'path'; path.title = value;
      const parts = value.split('/'); const tail = parts.splice(-2).join('/');
      for (const [text, cls] of [[parts.length ? parts.join('/') + '/' : '', 'path-parent'], [tail, 'path-tail']]) {
        const span = document.createElement('span'); span.className = cls; span.textContent = text; path.append(span);
      }
      detail.append(path);
    } else { detail.textContent = value; if (machine) detail.className = 'machine'; }
    const row = document.createElement('div'); row.className = 'context-row'; row.append(term, detail);
    document.getElementById('context').append(row);
  }
  document.getElementById('reveal').addEventListener('change', event => form.classList.toggle('show', event.target.checked));
  document.getElementById('cancel').addEventListener('click', async () => {
    controls().forEach(control => { control.disabled = true; });
    try { await call('cancel', {}); finish(editing ? 'Secret edit canceled' : 'Secret setup canceled', editing ? 'The stored value was not changed. You can close this tab.' : 'No application was started. Earlier approvals and saved values remain. Return to your agent only when you want to resume setup.'); }
    catch (error) { finish('Could not cancel setup', error.message + (editing ? ' Close this tab; the private form expires automatically.' : ' Check setup status in your client before retrying.'), 'warning'); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (needsApproval) {
      controls().forEach(control => { control.disabled = true; }); message.textContent = 'Allowing the requested names…';
      try {
        const approved = await call('approve', {});
        if (approved.state === 'pending') render(approved); else completion(approved);
      } catch (error) { finish('Could not approve access', error.message + ' Check setup status in your client before retrying.', 'warning'); }
      return;
    }
    if (store && store.state !== 'unlocked') {
      const password = document.getElementById('password');
      const input = { password: password.value, create: store.state === 'new',
        confirmation: document.getElementById('confirmation')?.value, remember: document.getElementById('remember')?.checked || false };
      clear(); controls().forEach(control => { control.disabled = true; });
      try {
        const unlocked = await call('unlock', input);
        if (unlocked.state === 'pending') render(unlocked); else completion(unlocked);
      } catch (error) { message.textContent = error.message; controls().forEach(control => { control.disabled = false; }); password.focus(); }
      finally { input.password = ''; input.confirmation = ''; }
      return;
    }
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
      completion(saved);
    } catch (error) {
      finish(editing ? 'Save could not be confirmed' : 'Check the save result in your client',
        'The response was lost or rejected. A write may have completed. ' + (editing ? 'Open a new edit form to save your intended value. ' : 'Check secret setup status before retrying. ') + error.message, 'warning');
    } finally { for (const id of Object.keys(values)) delete values[id]; }
  });
  window.addEventListener('pagehide', () => { clear(); capability = ''; });
  function render(request) {
    clear(); fields.replaceChildren(); document.getElementById('context').replaceChildren();
    editing = request.mode === 'edit';
    store = request.keystore;
    document.getElementById('crumb').textContent = editing ? 'Edit secret' : 'Private setup';
    needsApproval = request.requirements.some(item => !item.selected);
    document.getElementById('title').textContent = needsApproval ? 'Allow these secret names?' : request.mode === 'edit' ? 'Replace a stored secret' : 'Add missing secrets';
    message.textContent = needsApproval ? 'These exact stored references are shared across projects that select them. Existing values will be reused, never shown or overwritten.' :
      request.mode === 'edit' ? 'Replacement affects all future readers of this exact secret name. Existing values are never shown.' :
      'Enter only the missing values below. An entry created elsewhere while this form is open keeps its value.';
    document.getElementById('scope').textContent = needsApproval ?
      'Allow this runtime to use these names until it shuts down. Any execution-authorized preview on this runtime can bind an allowed name. This does not start an application.' :
      editing ? 'Save replaces this exact reference in the encrypted keystore. Running applications and access approvals stay unchanged.' :
      'Save stores values in the encrypted keystore without starting an application. Earlier access approvals last until this runtime shuts down.';
    document.getElementById('submit').textContent = needsApproval ? 'Allow names' : 'Save secrets';
    document.getElementById('reveal-label').hidden = needsApproval || editing;
    describe(editing ? 'Local address' : 'Runtime', location.origin, true);
    if (request.name) describe('Preview', request.name);
    for (const source of request.sources) describe('Source directory', source);
    describe('Expires', new Date(request.expiresAt).toLocaleTimeString(), true);
    if (!needsApproval && store && store.state !== 'unlocked') {
      const creating = store.state === 'new';
      document.getElementById('title').textContent = creating ? 'Create your keystore' : 'Unlock your keystore';
      message.textContent = store.warning || (creating ? 'Choose a password of at least 12 characters. Keep it somewhere safe; Previewhost cannot recover it.' : 'Enter your password to unlock this owner until it shuts down.');
      document.getElementById('scope').textContent = 'Unlocking does not grant access to more secret references or start applications. Other owners need their own unlock.';
      for (const [id, label] of [['password', 'Keystore password'], ...(creating ? [['confirmation', 'Confirm password']] : [])]) {
        const wrapper = document.createElement('label'); wrapper.className = 'field'; wrapper.textContent = label;
        const input = document.createElement('input'); input.id = id; input.type = 'password'; input.required = true; input.maxLength = 4096;
        input.autocomplete = creating ? 'new-password' : 'current-password'; wrapper.append(input); fields.append(wrapper);
      }
      if (store.canRemember) {
        const label = document.createElement('label'); label.className = 'reveal';
        const input = document.createElement('input'); input.id = 'remember'; input.type = 'checkbox';
        label.append(input, 'Remember unlock on this Mac'); fields.append(label);
      }
      document.getElementById('submit').textContent = creating ? 'Create keystore' : 'Unlock';
      document.getElementById('reveal-label').hidden = true;
      controls().forEach(control => { control.disabled = false; }); form.hidden = false;
      document.getElementById('password').focus(); return;
    }
    if (store?.warning) message.textContent = store.warning;
    for (const id of request.remaining) {
      const requirement = request.requirements.find(item => item.id === id);
      const wrapper = document.createElement('div'); wrapper.className = 'field';
      const label = document.createElement(needsApproval ? 'strong' : 'label'); label.textContent = id; label.className = 'machine';
      const recipients = document.createElement('span'); recipients.className = 'recipient';
      recipients.textContent = requirement.bindings.length ? 'Used here by: ' : 'Shared entry; recipients depend on future requests.';
      requirement.bindings.forEach((item, index) => {
        if (index) recipients.append(', ');
        if (item.service) recipients.append(item.service + ' · ');
        const key = document.createElement('code'); key.textContent = item.key; recipients.append(key);
      });
      wrapper.append(label, recipients);
      if (!needsApproval) {
        const field = document.createElement('textarea');
        field.className = 'machine'; field.id = 'secret-' + fields.children.length; field.dataset.id = id; field.required = true; field.spellcheck = false;
        field.autocomplete = 'off'; field.autocapitalize = 'off'; field.setAttribute('autocorrect', 'off');
        label.htmlFor = field.id; wrapper.append(field);
      }
      fields.append(wrapper);
    }
    controls().forEach(control => { control.disabled = false; });
    form.hidden = false; fields.querySelector('textarea')?.focus();
  }
  (async () => {
    if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error('This private link is unavailable. Open a new secret setup request from your client.');
    render(await call('form', {}));
  })().catch(error => { finish('Private setup unavailable', error.message, 'warning'); });
})();`;
