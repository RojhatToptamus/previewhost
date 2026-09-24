import { ArrowRight, ArrowUpRight, Check, ChevronRight, Code2, Database, FileCode2, Grid2X2, Layers, Play, RotateCcw, Search, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import brandSvg from "../../assets/previewhost.svg?raw";
import exampleYaml from "../../examples/multi-repo/environment.yaml?raw";
import { LandingTabs } from "./landing-tabs";
import { pageHref } from "./pages";
import "./product-demo.css";

const mark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");
const address = "shared-notes--frontend.localhost:49837";
const stages = ["databases", "migration", "api", "reporting", "frontend", "ready"] as const;
type DemoState = (typeof stages)[number] | "failed";
type View = "activity" | "logs" | "configuration";
const views = [{ id: "activity", label: "Activity" }, { id: "logs", label: "Logs" }, { id: "configuration", label: "Configuration" }] as const;
const services = [
  { name: "frontend", type: "HTTP", step: 4, icon: Code2 },
  { name: "api", type: "HTTP", step: 2, icon: Terminal },
  { name: "reporting", type: "HTTP", step: 3, icon: Terminal },
  { name: "database", type: "PostgreSQL", step: 0, icon: Database },
  { name: "cache", type: "Redis", step: 0, icon: Layers },
];
const output = [
  { source: "migrate", text: "Notes schema ready.", step: 1 },
  { source: "api", text: "api v1: ready for HTTP requests.", step: 2 },
  { source: "reporting", text: "reporting v1: ready for HTTP requests.", step: 3 },
  { source: "frontend", text: "frontend v1: ready for HTTP requests.", step: 4 },
];
const progressCopy: Record<DemoState, string> = {
  databases: "Starting PostgreSQL and Redis.",
  migration: "Running the migration against PostgreSQL.",
  api: "Starting the API after its migration and databases are ready.",
  reporting: "Starting reporting after the API is ready.",
  frontend: "Starting the frontend after the API and reporting are ready.",
  ready: "The stack is ready. Open the app, or explore its logs and configuration.",
  failed: "The update failed. The previous preview and its URL are still serving.",
};

function Status({ value }: { value: string }) {
  return <span className="demo-status" data-tone={value === "Ready" || value === "Succeeded" ? "success" : value === "Failed" || value === "Update failed" ? "error" : "muted"}>{value}</span>;
}

function DemoLogs({ state, step, source, setSource, attempt, setAttempt }: { state: DemoState; step: number; source: string; setSource: (source: string) => void; attempt: string; setAttempt: (attempt: string) => void }) {
  const [query, setQuery] = useState("");
  const lines = state === "failed" && attempt === "latest"
    ? [{ source: "migrate", text: "Migration failed. Inspect the local database before retrying.", step: 1 }]
    : output.filter(line => line.step < step);
  const filtered = lines.filter(line => (!source || line.source === source) && `${line.source} ${line.text}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="demo-logs">
    <div className="demo-log-controls">
      <label className="demo-search"><Search aria-hidden="true" /><span className="landing-sr-only">Search example logs</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search output…" type="search" /></label>
      <label><span className="landing-sr-only">Log source</span><select aria-label="Log source" value={source} onChange={event => setSource(event.target.value)}><option value="">All sources</option>{output.map(line => <option key={line.source}>{line.source}</option>)}</select></label>
      {state === "failed" && <label><span className="landing-sr-only">Log attempt</span><select aria-label="Log attempt" value={attempt} onChange={event => setAttempt(event.target.value)}><option value="latest">Latest update</option><option value="serving">Serving</option></select></label>}
    </div>
    <p className="demo-section-label">Captured output</p>
    <div className="demo-log-output" tabIndex={0} aria-label="Example log output">
      {filtered.length ? filtered.map((line, index) => <div key={line.source} className="demo-log-line"><span>{String(index + 1).padStart(2, "0")}</span><code>{line.source}</code><pre>{line.text}</pre></div>) : <p className="demo-empty">{query || source ? "No output matches these filters." : "No output captured yet."}</p>}
    </div>
  </div>;
}

function ExampleApp({ dialog, notes, saveNote }: { dialog: React.RefObject<HTMLDialogElement | null>; notes: string[]; saveNote: (note: string) => void }) {
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  return <dialog ref={dialog} className="demo-app-dialog" aria-labelledby="example-app-title">
    <div className="demo-app-bar"><span>Example app</span><span>Demo data only</span><button type="button" onClick={() => dialog.current?.close()} aria-label="Close example app"><X aria-hidden="true" /></button></div>
    <div className="demo-app-content">
      <p className="demo-section-label">Previewhost / multi-repository example</p>
      <h2 id="example-app-title">Shared notes</h2>
      <p>Write through the API. Read the same data through reporting.</p>
      <div className="demo-app-revisions"><span>Web: v1</span><span>API: v1</span><span>Reporting: v1</span></div>
      <form onSubmit={event => { event.preventDefault(); if (!draft.trim()) return; saveNote(draft.trim()); setDraft(""); setSaved(true); }}>
        <label htmlFor="example-note">Add a note</label>
        <div><input id="example-note" value={draft} onChange={event => { setDraft(event.target.value); setSaved(false); }} required maxLength={160} placeholder="Something worth keeping" autoComplete="off" /><button className="demo-button demo-primary" type="submit">Save note</button></div>
        <span className="demo-app-feedback" role="status">{saved ? "Saved in this example." : "Changes stay in this demo and reset when you reload the page."}</span>
      </form>
      <div className="demo-app-results"><section aria-label="Recent notes"><h3>Recent notes</h3>{notes.length ? <ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>No notes yet. Add the first one.</p>}</section><section aria-label="Shared data check"><h3>Shared data check</h3><dl><dt>Notes in PostgreSQL</dt><dd>{notes.length}</dd><dt>Latest note in Redis</dt><dd>{notes[0] ?? "No cached note yet."}</dd></dl></section></div>
    </div>
  </dialog>;
}

export function ProductDemo() {
  const [state, setState] = useState<DemoState>("ready");
  const [view, setView] = useState<View>("activity");
  const [overview, setOverview] = useState(false);
  const [source, setSource] = useState("");
  const [logAttempt, setLogAttempt] = useState("serving");
  const [notes, setNotes] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const step = state === "failed" ? stages.length - 1 : stages.indexOf(state);
  const starting = step < stages.length - 1;
  const status = state === "failed" ? "Update failed" : starting ? "Starting" : "Ready";

  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(() => setState(stages[step + 1]), 700);
    return () => clearTimeout(timer);
  }, [starting, step]);

  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
  }, [view]);

  function showLogs(name = "", attempt = state === "failed" ? "latest" : "serving") {
    setSource(name);
    setLogAttempt(attempt);
    setView("logs");
    requestAnimationFrame(() => document.getElementById("example-view-logs")?.focus({ preventScroll: true }));
  }
  function runScenario(next: DemoState) {
    panel.current?.scrollTo({ top: 0 });
    setState(next);
    setView("activity");
    setSource("");
    setLogAttempt(next === "failed" ? "latest" : "serving");
    setOverview(false);
  }

  function openPreview() {
    setOverview(false);
    requestAnimationFrame(() => document.getElementById(`example-view-${view}`)?.focus({ preventScroll: true }));
  }

  return <section id="product-demo" className="product-demo" aria-label="Interactive Previewhost example" aria-describedby="demo-disclosure">
    <div className="demo-stage">
      <div className="demo-window">
        <aside className="demo-sidebar" aria-label="Example preview navigation">
          <div className="demo-brand"><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} /><strong>previewhost</strong></div>
          <button className="demo-overview-button" type="button" aria-pressed={overview} onClick={() => setOverview(true)}><Grid2X2 aria-hidden="true" />All previews<span>1</span></button>
          <div className="demo-sidebar-label">Previews</div>
          <button type="button" className="demo-preview-button" aria-pressed={!overview} onClick={() => setOverview(false)}><span>shared-notes</span><code>~/projects/shared-notes</code><Status value={status} /></button>
        </aside>
        <div className="demo-workspace">
          {overview ? <div className="demo-overview"><h2>All previews</h2><p>Apps running from your local source.</p><button type="button" onClick={openPreview}><span><strong>shared-notes</strong><code>~/projects/shared-notes</code></span><Status value={status} /><ChevronRight aria-hidden="true" /></button></div> : <>
            <div className="demo-preview-header">
              <div className="demo-identity"><div><h2>shared-notes</h2><Status value={status} /></div><code className="demo-path">~/projects/shared-notes</code><span className="demo-address"><ArrowUpRight aria-hidden="true" /><code>{starting ? "Waiting for the frontend…" : address}</code></span></div>
              <button type="button" className="demo-button demo-primary" disabled={starting} onClick={() => dialog.current?.showModal()}>Open app<ArrowUpRight aria-hidden="true" /></button>
            </div>
            <LandingTabs id="example-view" label="Example product views" items={views} selected={view} onSelect={setView} />
            <div ref={panel} className="demo-panel" id="example-view-panel" role="tabpanel" aria-labelledby={`example-view-${view}`} tabIndex={0}>
              <div key={view} className="demo-view-content">
                {view === "activity" && <>
                  {state === "failed" ? <div className="demo-attempts"><div><span>Serving</span><strong><code>a31e7ac1</code><Status value="Ready" /></strong></div><div><span>Latest update</span><strong><code>af912434</code><Status value="Failed" /></strong><button type="button" onClick={() => showLogs("migrate")} aria-label="View failed migration logs">Migration logs<ArrowRight aria-hidden="true" /></button></div><p>Source edits and database writes are not rolled back.</p></div> : <div className="demo-attempt-line"><span>{starting ? "Starting" : "Serving"}</span><code>a31e7ac1</code>{starting && <span className="demo-starting-label">{progressCopy[state]}</span>}</div>}
                  <p className="demo-section-label">Services{state === "failed" ? " · Serving" : ""}</p>
                  <table className="demo-services"><thead><tr><th>Service</th><th>Type</th><th>Status</th><th className="demo-connection">Connection</th><th><span className="landing-sr-only">Actions</span></th></tr></thead><tbody>{services.map(service => {
                    const state = step > service.step ? "Ready" : step === service.step ? "Starting" : "Waiting";
                    return <tr key={service.name}><th scope="row"><service.icon aria-hidden="true" /><span>{service.name}</span></th><td>{service.type}</td><td><Status value={state} /></td><td className="demo-connection"><code>{service.type === "HTTP" ? (starting ? "—" : `shared-notes--${service.name}.localhost:49837`) : "Data retained"}</code></td><td>{service.type === "HTTP" && <button type="button" onClick={() => showLogs(service.name, "serving")} aria-label={`View ${service.name} logs`}>Logs</button>}</td></tr>;
                  })}</tbody></table>
                  <div className="demo-job"><div><p className="demo-section-label">Setup jobs{state === "failed" ? " · Latest update" : ""}</p><span><Terminal aria-hidden="true" /><strong>migrate</strong><Status value={state === "failed" ? "Failed" : step > 1 ? "Succeeded" : step === 1 ? "Running" : "Waiting"} /></span></div><button type="button" onClick={() => showLogs("migrate")} aria-label="View migration logs">Logs</button></div>
                </>}
                {view === "logs" && <DemoLogs key={state === "failed" ? "failed" : "serving"} state={state} step={step} source={source} setSource={setSource} attempt={logAttempt} setAttempt={setLogAttempt} />}
                {view === "configuration" && <div className="demo-configuration"><div className="demo-config-heading"><span><FileCode2 aria-hidden="true" />Example configuration</span><a href={pageHref("configuration")}>Configuration guide<ArrowUpRight aria-hidden="true" /></a></div><pre tabIndex={0} aria-label="Shared notes configuration"><code>{exampleYaml}</code></pre></div>}
              </div>
            </div>
          </>}
        </div>
      </div>
    </div>
    <div className="demo-controls">
      <div className="demo-control-copy"><strong>Try a local preview.</strong><p id="demo-disclosure">Interactive example. Nothing starts on your machine.</p></div>
      <div className="demo-scenarios" aria-label="Example workflows">
        <button type="button" disabled={starting} onClick={() => runScenario("databases")}><Play aria-hidden="true" />{starting ? "Starting the stack…" : "Play startup"}</button>
        <button type="button" aria-pressed={state === "failed"} disabled={starting} onClick={() => runScenario(state === "failed" ? "ready" : "failed")}>{state === "failed" ? <RotateCcw aria-hidden="true" /> : <Code2 aria-hidden="true" />}{state === "failed" ? "Show ready state" : "Try a failed update"}</button>
      </div>
    </div>
    <p className="demo-progress" role="status">{state === "ready" && <Check aria-hidden="true" />}{progressCopy[state]}</p>
    <noscript><p className="demo-noscript">Enable JavaScript to explore this example, or <a href={pageHref("first-preview")}>start a local preview from the CLI</a>.</p></noscript>
    <ExampleApp dialog={dialog} notes={notes} saveNote={note => setNotes(previous => [note, ...previous])} />
  </section>;
}
