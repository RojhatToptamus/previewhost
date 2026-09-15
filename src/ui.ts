/** Shared presentation only. Each page retains its own authorization and state. */
export const uiStyle = `
@font-face { font-family:Geist; src:url('/fonts/geist.woff2') format('woff2'); font-weight:100 900; font-style:normal; font-display:swap; }
@font-face { font-family:'Geist Mono'; src:url('/fonts/geist-mono.woff2') format('woff2'); font-weight:100 900; font-style:normal; font-display:swap; }
body {
  --bg:#ffffff; --subtle:#fafafa; --surface:#ffffff; --hover:#f5f5f5; --sel:#f0f0f0;
  --border:#ebebeb; --border-2:#e0e0e0; --divider:#f0f0f0; --divider-2:#f5f5f5;
  --t1:#000000; --t2:#333333; --t3:#525252; --t4:#666666; --t5:#8f8f8f; --t6:#a1a1a1; --t7:#b4b4b4;
  --inv-bg:#000000; --inv-fg:#ffffff;
  --ok:#0f7b55; --err:#c5372c; --warn:#9a6700;
  --err-border:#eddcda; --warn-border:#ece4d3; --err-soft:#8a3a33;
  color-scheme:light;
}
body.ph-dark {
  --bg:#000000; --subtle:#0a0a0a; --surface:#0a0a0a; --hover:#161616; --sel:#1f1f1f;
  --border:#262626; --border-2:#333333; --divider:#1f1f1f; --divider-2:#1a1a1a;
  --t1:#ededed; --t2:#d4d4d4; --t3:#b4b4b4; --t4:#a1a1a1; --t5:#8f8f8f; --t6:#6f6f6f; --t7:#5a5a5a;
  --inv-bg:#ededed; --inv-fg:#000000;
  --ok:#4cc38a; --err:#f97066; --warn:#d9a441;
  --err-border:#3a2320; --warn-border:#37301c; --err-soft:#f0a29b;
  color-scheme:dark;
}
* { box-sizing:border-box; }
body { margin:0; font:14px/1.5 Geist,system-ui,sans-serif; -webkit-font-smoothing:antialiased; color:var(--t1); background:var(--bg); }
button,input,select,textarea { font:inherit; }
button,.button { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:32px; flex:none; padding:0 14px; border:1px solid var(--border-2); border-radius:6px; background:var(--bg); color:var(--t2); font-size:13px; font-weight:500; white-space:nowrap; cursor:pointer; text-decoration:none; transition:background-color 120ms,border-color 120ms,color 120ms; }
button:hover,.button:hover { border-color:var(--t1); color:var(--t1); }
button:disabled { background:var(--subtle); border-color:var(--border); color:var(--t4); cursor:not-allowed; }
button.primary,.button.primary { background:var(--inv-bg); border-color:var(--inv-bg); color:var(--inv-fg); }
button.primary:hover,.button.primary:hover { background:var(--t2); }
button.danger { color:var(--err); border-color:var(--err-border); }
.hero { height:36px; padding:0 18px; font-size:13.5px; }
.small { height:26px; padding:0 10px; font-size:12px; border-radius:5px; }
:focus-visible { outline:2px solid var(--t2); outline-offset:3px; }
h1:focus { outline:none; }
a { color:var(--t1); text-underline-offset:3px; }
a:not([href]) { pointer-events:none; color:var(--t5); }
header { display:flex; align-items:center; gap:12px; padding:0 20px; height:52px; min-height:52px; border-bottom:1px solid var(--border); }
.brand { border:0; padding:0; height:auto; color:var(--t1); font-size:14.5px; font-weight:600; letter-spacing:-.2px; background:none; }
.slash { color:var(--border-2); }
#crumb { color:var(--t4); font-size:13.5px; }
header>button:not(.brand) { height:30px; padding:0 11px; }

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
.notice { padding:18px 20px; border:1px solid var(--border); border-radius:9px; margin-bottom:26px; background:var(--subtle); color:var(--t1); }
.notice.error { border-color:var(--err-border); }
.notice.warning { border-color:var(--warn-border); }
.notice p { font-size:13.5px; line-height:1.6; color:var(--t3); max-width:640px; overflow-wrap:anywhere; }
.notice p:last-child { margin:0; }
.notice button { margin-top:4px; }
.actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding-bottom:16px; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
[hidden] { display:none!important; }
@media (prefers-reduced-motion:reduce) { button,.button { transition:none; } }
`;

function mountTheme() {
  const theme = document.querySelector<HTMLButtonElement>('#theme')!;
  try { document.body.classList.toggle('ph-dark', localStorage.getItem('previewhost.theme') === 'dark'); } catch { /* Use light when storage is unavailable. */ }
  function updateTheme() {
    const dark = document.body.classList.contains('ph-dark');
    theme.textContent = dark ? 'Light' : 'Dark';
    theme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  updateTheme();
  theme.addEventListener('click', () => {
    const dark = document.body.classList.toggle('ph-dark');
    try { localStorage.setItem('previewhost.theme', dark ? 'dark' : 'light'); } catch { /* Theme remains usable for this page. */ }
    updateTheme();
  });
}

export const themeScript = `(${mountTheme.toString()})();`;
