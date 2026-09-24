import { ArrowRight, ArrowUpRight, ChevronRight, Code2, Database, FileCode2, GitBranch, Grid2X2, KeyRound, Layers, Search, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import brandSvg from "../../assets/previewhost.svg?raw";
import exampleYaml from "../../examples/multi-repo/environment.yaml?raw";
import { LandingTabs } from "./landing-tabs";
import { pageHref } from "./pages";
import "./product-demo.css";

const mark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");
const previews = [
  { id: "notes-main", project: "shared-notes", branch: "main", path: "~/code/shared-notes", port: 49837, failed: false, static: false },
  { id: "notes-export", project: "shared-notes", branch: "feature/export", path: "~/worktrees/shared-notes-export", port: 49902, failed: true, static: false },
  { id: "docs-main", project: "docs-site", branch: "main", path: "~/code/docs-site", port: 49961, failed: false, static: true },
] as const;
type Preview = (typeof previews)[number];
type Selection = Preview["id"] | "overview" | "secrets";
type View = "activity" | "logs" | "configuration";
const views = [{ id: "activity", label: "Activity" }, { id: "logs", label: "Logs" }, { id: "configuration", label: "Configuration" }] as const;
const services = [
  { name: "frontend", type: "HTTP", icon: Code2 },
  { name: "api", type: "HTTP", icon: Terminal },
  { name: "reporting", type: "HTTP", icon: Terminal },
  { name: "database", type: "PostgreSQL", icon: Database },
  { name: "cache", type: "Redis", icon: Layers },
];
const output = [
  { source: "migrate", text: "Notes schema ready." },
  { source: "api", text: "api v1: ready for HTTP requests." },
  { source: "reporting", text: "reporting v1: ready for HTTP requests." },
  { source: "frontend", text: "frontend v1: ready for HTTP requests." },
];
const references = ["notes/dev/api-token", "notes/export/api-token"];
const address = (preview: Preview) => preview.static ? `127.0.0.1:${preview.port}` : `${preview.project}--frontend.localhost:${preview.port}`;
const previewStatus = (preview: Preview) => preview.failed ? "Update failed" : "Ready";

function Status({ value }: { value: string }) {
  return <span className="demo-status" data-tone={value === "Ready" || value === "Succeeded" ? "success" : value === "Failed" || value === "Update failed" ? "error" : "muted"}>{value}</span>;
}

function SecretManager() {
  const [query, setQuery] = useState("");
  const filtered = references.filter(reference => reference.includes(query.toLowerCase()));
  return <div className="demo-secret-manager">
    <h2>Secret Manager</h2><p className="demo-description">Stored references</p>
    <label className="demo-search"><Search aria-hidden="true" /><input aria-label="Search secret references" type="search" placeholder="Search references…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <ul className="demo-reference-list">{filtered.map(reference => <li key={reference}><KeyRound aria-hidden="true" /><code>{reference}</code><span>Stored</span></li>)}</ul>
    {!filtered.length && <p className="demo-empty">No references match your search.</p>}
    <div className="demo-secret-explanation"><h3>References in configuration. Values entered privately.</h3><pre><code>{'API_TOKEN: {secret: "notes/dev/api-token"}'}</code></pre><p>The agent names the reference. You approve access and enter missing values in Previewhost’s private form. The same name shares one stored value wherever approved.</p><a href={pageHref("secrets")}>How secret access works<ArrowUpRight aria-hidden="true" /></a></div>
    <p className="demo-footnote">These are example names. This demo stores no secrets and has no private-value input.</p>
  </div>;
}

function Configuration({ preview }: { preview: Preview }) {
  const yaml = preview.static ? "name: docs-site\ntype: static\ndirectory: ./site\n" : exampleYaml;
  return <div className="demo-configuration">
    <div className="demo-config-heading"><span><FileCode2 aria-hidden="true" />preview.yaml</span><a href={pageHref("configuration")}>Configuration guide<ArrowUpRight aria-hidden="true" /></a></div>
    <p className="demo-section-label">Source directories</p>
    <dl className="demo-source-list">{(preview.static ? ["site"] : ["frontend", "api", "reporting"]).map(source => <div key={source}><dt>{source}</dt><dd><code>{preview.path}/{source}</code></dd></div>)}</dl>
    {!preview.static && <><p className="demo-section-label">Environment bindings</p><table className="demo-binding-table"><thead><tr><th>Recipient</th><th>Variable</th><th>Binding</th></tr></thead><tbody>
      <tr><td>frontend</td><th scope="row"><code>API_URL</code></th><td><code>{'{service: api}'}</code></td></tr>
      <tr><td>frontend</td><th scope="row"><code>PUBLIC_API_URL</code></th><td><code>{'{browserUrl: api}'}</code></td></tr>
      <tr><td>api</td><th scope="row"><code>DATABASE_URL</code></th><td><code>{'{service: database}'}</code></td></tr>
      <tr><td>api</td><th scope="row"><code>REDIS_URL</code></th><td><code>{'{service: cache}'}</code></td></tr>
    </tbody></table><p className="demo-footnote">Service bindings supply connection URLs and wait for readiness. Browser URL bindings supply an address without adding a dependency.</p></>}
    {preview.static && <p className="demo-description">Serves prepared HTML and assets. No application process or database is needed.</p>}
    <details className="demo-yaml"><summary>View complete YAML</summary><pre tabIndex={0} aria-label={`${preview.project} configuration`}><code>{yaml}</code></pre></details>
  </div>;
}

function PreviewDetail({ preview, openApp }: { preview: Preview; openApp: () => void }) {
  const [view, setView] = useState<View>("activity");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(preview.failed ? "latest" : "serving");
  const panel = useRef<HTMLDivElement>(null);
  const lines = preview.static ? [] : preview.failed && attempt === "latest"
    ? [{ source: "migrate", text: "Migration failed. Inspect the local database before retrying." }] : output;
  const filtered = lines.filter(line => (!source || line.source === source) && `${line.source} ${line.text}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [view]);
  function showLogs(name: string, nextAttempt = "serving") {
    setSource(name); setQuery(""); setAttempt(nextAttempt); setView("logs");
    requestAnimationFrame(() => document.getElementById("example-view-logs")?.focus({ preventScroll: true }));
  }
  return <>
    <div className="demo-preview-header">
      <div className="demo-identity"><div><h2>{preview.project}</h2><Status value={previewStatus(preview)} /></div><span className="demo-branch"><GitBranch aria-hidden="true" />{preview.branch}</span></div>
      <button type="button" className="demo-button demo-primary" onClick={openApp}>Open app<ArrowUpRight aria-hidden="true" /></button>
    </div>
    <dl className="demo-metadata"><div><dt>Project</dt><dd><code>{preview.path}</code></dd></div><div><dt>{preview.static ? "Localhost" : "Hostname"}</dt><dd className="demo-address"><code>{address(preview)}</code></dd></div></dl>
    <LandingTabs id="example-view" label="Example product views" items={views} selected={view} onSelect={setView} />
    <div ref={panel} className="demo-panel" id="example-view-panel" role="tabpanel" aria-labelledby={`example-view-${view}`} tabIndex={0}>
      <div key={view} className="demo-view-content">
        {view === "activity" && <>
          {preview.failed ? <div className="demo-attempts"><div><span>Serving</span><Status value="Ready" /></div><div><span>Latest update</span><Status value="Failed" /><button type="button" onClick={() => showLogs("migrate", "latest")}>View failed migration logs<ArrowRight aria-hidden="true" /></button></div><p>Previous preview still serving. Source edits and database writes are not rolled back.</p></div> : <div className="demo-attempt-line"><span>Serving</span><Status value="Ready" /></div>}
          <p className="demo-section-label">{preview.static ? "Static preview" : "Services · Serving"}</p>
          {preview.static ? <div className="demo-static"><FileCode2 aria-hidden="true" /><div><strong>./site</strong><p>Prepared files served at the preview URL.</p></div><Status value="Ready" /></div> : <>
            <table className="demo-services"><thead><tr><th>Service</th><th>Type</th><th>Status</th><th className="demo-connection">Connection</th><th><span className="landing-sr-only">Actions</span></th></tr></thead><tbody>{services.map(service => <tr key={service.name}><th scope="row"><service.icon aria-hidden="true" /><span>{service.name}</span></th><td>{service.type}</td><td><Status value="Ready" /></td><td className="demo-connection"><code>{service.type === "HTTP" ? `shared-notes--${service.name}.localhost:${preview.port}` : "Managed · this worktree"}</code></td><td>{service.type === "HTTP" && <button type="button" onClick={() => showLogs(service.name)} aria-label={`View ${service.name} logs`}>Logs</button>}</td></tr>)}</tbody></table>
            <div className="demo-job"><div><p className="demo-section-label">Setup jobs{preview.failed ? " · Latest update" : ""}</p><span><Terminal aria-hidden="true" /><strong>migrate</strong><Status value={preview.failed ? "Failed" : "Succeeded"} /></span></div><button type="button" onClick={() => showLogs("migrate", preview.failed ? "latest" : "serving")} aria-label="View migration logs">Logs</button></div>
          </>}
        </>}
        {view === "logs" && <div className="demo-logs">
          <div className="demo-log-controls"><label className="demo-search"><Search aria-hidden="true" /><input aria-label="Search example logs" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search output…" type="search" /></label><select aria-label="Log source" value={source} onChange={event => setSource(event.target.value)}><option value="">All output</option>{!preview.static && output.map(line => <option key={line.source}>{line.source}</option>)}</select>{preview.failed && <select aria-label="Log attempt" value={attempt} onChange={event => setAttempt(event.target.value)}><option value="latest">Latest update</option><option value="serving">Serving</option></select>}</div>
          <p className="demo-section-label">Captured process output</p>
          <div className="demo-log-output" tabIndex={0} aria-label="Example log output">{filtered.length ? filtered.map((line, index) => <div key={line.source} className="demo-log-line"><span>{String(index + 1).padStart(2, "0")}</span><code>{line.source}</code><pre>{line.text}</pre></div>) : <p className="demo-empty">{preview.static ? "Static previews have no process output." : "No output matches these filters."}</p>}</div>
          <p className="demo-footnote">Command and job stdout/stderr. Browser-console output appears only if the framework forwards it to a captured process.</p>
        </div>}
        {view === "configuration" && <Configuration preview={preview} />}
      </div>
    </div>
  </>;
}

function ExampleApp({ dialog, preview, notes, saveNote }: { dialog: RefObject<HTMLDialogElement | null>; preview: Preview; notes: string[]; saveNote: (note: string) => void }) {
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  return <dialog ref={dialog} className="demo-app-dialog" aria-labelledby="example-app-title">
    <div className="demo-app-bar"><span>Example app</span><span>Simulated data</span><button type="button" onClick={() => dialog.current?.close()} aria-label="Close example app"><X aria-hidden="true" /></button></div>
    <div className="demo-app-content">
      <p className="demo-section-label">{preview.project} / {preview.branch}</p><h2 id="example-app-title">{preview.static ? "Your local preview." : "Shared notes"}</h2>
      {preview.static ? <><p>This page comes from <code>./site</code>.</p><p>Prepared HTML and assets, served without an application process.</p></> : <>
        <p>Write through the API. Read the same data through reporting.</p>
        <form onSubmit={event => { event.preventDefault(); if (!draft.trim()) return; saveNote(draft.trim()); setDraft(""); setSaved(true); }}><label htmlFor="example-note">Add a note</label><div><input id="example-note" value={draft} onChange={event => { setDraft(event.target.value); setSaved(false); }} required maxLength={160} placeholder="Something worth keeping" autoComplete="off" /><button className="demo-button demo-primary" type="submit">Save note</button></div><span className="demo-app-feedback" role="status">{saved ? "Saved in this example worktree." : "Try a note here, then open the other worktree. Its data stays separate."}</span></form>
        <div className="demo-app-results"><section aria-label="Recent notes"><h3>Recent notes</h3><ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section><section aria-label="Shared data check"><h3>Shared data check</h3><dl><dt>Notes in PostgreSQL</dt><dd>{notes.length}</dd><dt>Latest note in Redis</dt><dd>{notes[0]}</dd></dl></section></div>
      </>}
      <p className="demo-footnote">This example runs in your browser. Changes reset when you reload.</p>
    </div>
  </dialog>;
}

export function ProductDemo() {
  const [selection, setSelection] = useState<Selection>("notes-main");
  const [notes, setNotes] = useState<Record<string, string[]>>({ "notes-main": ["A note from the main worktree."], "notes-export": ["Export worktree: try the new report."] });
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = previews.find(preview => preview.id === selection) ?? previews[0];
  function selectPreview(id: Selection, focus = false) {
    setSelection(id);
    if (focus) requestAnimationFrame(() => document.getElementById("example-view-activity")?.focus({ preventScroll: true }));
  }
  return <section id="product-demo" className="product-demo" aria-label="Interactive Previewhost example" aria-describedby="demo-disclosure">
    <div className="demo-caption"><span>Explore three local previews</span><p id="demo-disclosure">Simulated example. No local services are started.</p></div>
    <div className="demo-window">
      <aside className="demo-sidebar" aria-label="Example preview navigation">
        <div className="demo-brand"><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} /><strong>previewhost</strong></div>
        <button className="demo-overview-button" type="button" aria-pressed={selection === "overview"} onClick={() => selectPreview("overview")}><Grid2X2 aria-hidden="true" />Overview<span>3</span></button>
        <button className="demo-overview-button" type="button" aria-pressed={selection === "secrets"} onClick={() => selectPreview("secrets")}><KeyRound aria-hidden="true" />Secret Manager</button>
        {["shared-notes", "docs-site"].map(project => <div className="demo-project-group" key={project}><p className="demo-sidebar-label">{project}</p>{previews.filter(preview => preview.project === project).map(preview => <button key={preview.id} type="button" className="demo-preview-button" aria-label={`${preview.project} ${preview.branch} ${previewStatus(preview)}`} aria-pressed={selection === preview.id} onClick={() => selectPreview(preview.id)}><span><GitBranch aria-hidden="true" />{preview.branch}</span><Status value={previewStatus(preview)} /></button>)}</div>)}
        <a className="demo-sidebar-guide" href={pageHref("dashboard")}>Dashboard guide<ArrowUpRight aria-hidden="true" /></a>
      </aside>
      <div className="demo-workspace">
        <label className="demo-mobile-select"><span>Explore</span><select aria-label="Choose example preview" value={selection} onChange={event => selectPreview(event.target.value as Selection)}><option value="overview">Overview · 3 previews</option>{previews.map(preview => <option key={preview.id} value={preview.id}>{preview.project} / {preview.branch}</option>)}<option value="secrets">Secret Manager</option></select></label>
        {selection === "overview" ? <div className="demo-overview"><h2>Overview</h2><p className="demo-description">3 previews across 2 repositories.</p><div className="demo-overview-list">{previews.map(preview => <button key={preview.id} type="button" onClick={() => selectPreview(preview.id, true)}><span><strong>{preview.project}</strong><span className="demo-branch"><GitBranch aria-hidden="true" />{preview.branch}</span><code>{preview.path}</code></span><Status value={previewStatus(preview)} /><ChevronRight aria-hidden="true" /></button>)}</div><p className="demo-footnote">The two shared-notes worktrees have separate ports, PostgreSQL data, and Redis data.</p></div>
          : selection === "secrets" ? <SecretManager />
            : <PreviewDetail key={preview.id} preview={preview} openApp={() => dialog.current?.showModal()} />}
      </div>
    </div>
    <div className="demo-takeaway"><GitBranch aria-hidden="true" /><p>Same repository, separate stacks. Open each worktree’s app to compare its data.</p><a href={pageHref("worktrees")}>Worktree guide<ArrowRight aria-hidden="true" /></a></div>
    <noscript><p className="demo-noscript">Enable JavaScript to switch previews and explore views, or <a href={pageHref("first-preview")}>follow the CLI quickstart</a>.</p></noscript>
    <ExampleApp key={preview.id} dialog={dialog} preview={preview} notes={notes[preview.id] ?? []} saveNote={note => setNotes(previous => ({ ...previous, [preview.id]: [note, ...previous[preview.id]] }))} />
  </section>;
}
