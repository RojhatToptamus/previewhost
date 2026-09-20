import { readFileSync } from 'node:fs';

const uiTokens = readFileSync(new URL('./ui-tokens.css', import.meta.url), 'utf8');

/** Shared presentation only. Each page retains its own authorization and state. */
export const uiStyle = `
${uiTokens}
* { box-sizing:border-box; }
body { margin:0; font:14px/1.5 Geist,system-ui,sans-serif; -webkit-font-smoothing:antialiased; color:var(--t1); background:var(--bg); }
button,input,select,textarea { font:inherit; }
button,.button { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:var(--control-height); flex:none; padding:0 12px; border:1px solid var(--border-2); border-radius:var(--control-radius); background:var(--bg); color:var(--t2); font-size:13px; font-weight:500; white-space:nowrap; cursor:pointer; text-decoration:none; transition:background-color 120ms,border-color 120ms,color 120ms; }
button:not(:disabled):hover,.button:hover { background:var(--hover); color:var(--t1); }
button:not(:disabled):active,.button:active { background:var(--sel); }
button.ghost,.button.ghost { border-color:transparent; background:transparent; }
button.ghost:not(:disabled):hover,.button.ghost:hover { background:var(--hover); }
button:disabled { opacity:.6; background:var(--subtle); border-color:var(--border); color:var(--t4); cursor:not-allowed; }
button.primary,.button.primary { background:var(--inv-bg); border-color:var(--inv-bg); color:var(--inv-fg); }
button.primary:not(:disabled):hover,.button.primary:hover { background:var(--t2); color:var(--inv-fg); }
button.danger { color:var(--err); border-color:var(--err-border); }
button.danger:not(:disabled):hover { background:var(--subtle); border-color:var(--err); }
.hero { height:36px; padding:0 18px; font-size:13.5px; }
.small { height:var(--control-small); padding:0 10px; font-size:12px; }
:focus-visible { outline:2px solid var(--t2); outline-offset:2px; }
h1:focus { outline:none; }
a { color:var(--t1); text-underline-offset:3px; }
a:not([href]) { pointer-events:none; color:var(--t5); }
header { display:flex; align-items:center; gap:12px; padding:0 20px; height:52px; min-height:52px; border-bottom:1px solid var(--border); }
#theme[aria-pressed=true] { background:var(--sel); color:var(--t1); }
.brand { border:0; padding:0; height:auto; color:var(--t1); font-size:14.5px; font-weight:600; letter-spacing:-.2px; background:none; }
.slash { color:var(--border-2); }
#crumb { color:var(--t4); font-size:13.5px; }
header>button:not(.brand) { padding:0 10px; }

h1 { margin:0 0 7px; font-size:30px; line-height:1.1; font-weight:600; letter-spacing:-.9px; overflow-wrap:anywhere; }
h2 { margin:0 0 6px; font-size:15px; font-weight:600; letter-spacing:-.2px; }
p { margin:0 0 10px; }
strong { font-weight:500; }
.muted { color:var(--t5); }
.machine,code,pre,time { font-family:'Geist Mono',monospace; font-size:12.5px; font-weight:400; }
.status { font-size:13px; font-weight:500; white-space:nowrap; }
.ready { color:var(--ok); }
.error { color:var(--err); }
.warning { color:var(--warn); }
.neutral { color:var(--t2); }
.section-label { font-size:11px; font-weight:500; letter-spacing:.06em; text-transform:uppercase; color:var(--t5); }
.path { display:flex; min-width:0; font-family:'Geist Mono',monospace; font-size:12.5px; white-space:nowrap; }
.path-parent { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--t5); }
.path-tail { flex:none; color:var(--t2); }
.notice { padding:18px 20px; border:1px solid var(--border); border-radius:var(--panel-radius); margin-bottom:24px; background:var(--subtle); color:var(--t1); }
.notice.error { border-color:var(--err-border); }
.notice.warning { border-color:var(--warn-border); }
.notice p { font-size:13.5px; line-height:1.6; color:var(--t3); max-width:640px; overflow-wrap:anywhere; }
.notice p:last-child { margin:0; }
.notice button { margin-top:4px; }
.actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding-bottom:16px; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
[hidden] { display:none!important; }

input:not([type=checkbox]),select,textarea { border:1px solid var(--border-2); border-radius:var(--control-radius); background:var(--bg); color:var(--t1); font-size:13px; transition:border-color 120ms; }
input:not([type=checkbox]),select { height:var(--control-height); padding:0 10px; }
input::placeholder,textarea::placeholder { color:var(--t4); }
input:not(:disabled):hover,select:not(:disabled):hover,textarea:not(:disabled):hover { border-color:var(--t5); }
input:disabled,select:disabled,textarea:disabled { opacity:.6; cursor:not-allowed; background:var(--subtle); }
[aria-invalid=true] { border-color:var(--err)!important; }
textarea { padding:12px; resize:vertical; }
.loading { display:flex; align-items:center; gap:8px; }
.loading::before { content:''; width:14px; height:14px; flex:none; border:1.5px solid currentColor; border-right-color:transparent; border-radius:50%; animation:ui-spin .8s linear infinite; }
@keyframes ui-spin { to { transform:rotate(360deg); } }

@media (prefers-reduced-motion:reduce) { button,.button,input,select,textarea { transition:none; } .loading::before { animation:none; } }
`;

function mountTheme() {
  const theme = document.querySelector<HTMLButtonElement>('#theme')!;
  try { document.body.classList.toggle('ph-dark', localStorage.getItem('previewhost.theme') === 'dark'); } catch { /* Use light when storage is unavailable. */ }
  function updateTheme() {
    const dark = document.body.classList.contains('ph-dark');
    theme.textContent = 'Dark mode';
    theme.setAttribute('aria-pressed', String(dark));
    theme.setAttribute('aria-label', 'Dark mode');
  }
  updateTheme();
  theme.addEventListener('click', () => {
    const dark = document.body.classList.toggle('ph-dark');
    try { localStorage.setItem('previewhost.theme', dark ? 'dark' : 'light'); } catch { /* Theme remains usable for this page. */ }
    updateTheme();
  });
}

export const themeScript = `(${mountTheme.toString()})();`;
