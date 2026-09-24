import { ArrowRight, ChevronRight, Code2, Database, FileCode2, GitBranch, Grid2X2, KeyRound, Layers, Pause, Play, Search, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import brandSvg from "../../assets/previewhost.svg?raw";
import exampleYaml from "../../examples/multi-repo/environment.yaml?raw";
import { LandingTabs } from "./landing-tabs";
import { DemoSelect } from "./demo-select";
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
type LogLine = { id: number; source: string; text: string; stream: "stdout" | "stderr" };
const initialOutput: LogLine[] = [
  { id: 1, source: "migrate", text: "Notes schema ready.", stream: "stdout" },
  { id: 2, source: "api", text: "api v1: ready for HTTP requests.", stream: "stdout" },
  { id: 3, source: "reporting", text: "reporting v1: ready for HTTP requests.", stream: "stdout" },
  { id: 4, source: "frontend", text: "frontend v1: ready for HTTP requests.", stream: "stdout" },
  { id: 5, source: "frontend", text: "GET / 200", stream: "stdout" },
  { id: 6, source: "api", text: "GET /notes 200", stream: "stdout" },
  { id: 7, source: "reporting", text: "GET /summary 200", stream: "stdout" },
];
// Representative application output; the website never contacts a preview runtime.
const incomingOutput = [
  { source: "frontend", text: "GET / 200" },
  { source: "api", text: "POST /notes 201" },
  { source: "api", text: "GET /notes 200" },
  { source: "reporting", text: "GET /summary 200" },
  { source: "frontend", text: "GET /style.css 200" },
];
const failedOutput: LogLine[] = [
  { id: 1, source: "migrate", text: "Migration failed. Inspect the local database before retrying.", stream: "stderr" },
  { id: 2, source: "migrate", text: "Job exited (1). Database writes are not rolled back.", stream: "stderr" },
];
const references = ["notes/dev/api-token", "notes/export/api-token"];
const address = (preview: Preview) => preview.static ? `127.0.0.1:${preview.port}` : `${preview.project}--frontend.localhost:${preview.port}`;
const previewStatus = (preview: Preview) => preview.failed ? "Update failed" : "Ready";

function Status({ value }: { value: string }) {
  return <span className="demo-status" data-tone={value === "Ready" || value === "Succeeded" ? "success" : value === "Failed" || value === "Update failed" ? "error" : "muted"}>{value}</span>;
}

function SecretManager() {
  const [query, setQuery] = useState("");
  const filtered = references.filter(reference => reference.includes(query.trim().toLowerCase()));
  return <div className="demo-secret-manager">
    <div className="demo-secret-heading"><h2>Secret Manager</h2><span>Unlocked</span></div>
    <div className="demo-secret-toolbar">
      <label className="demo-search"><Search aria-hidden="true" /><input aria-label="Search secret references" type="search" placeholder="Search references…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <span role="status">{filtered.length} shown</span>
    </div>
    <ul className="demo-reference-list">{filtered.map(reference => <li key={reference}><KeyRound aria-hidden="true" /><code>{reference}</code></li>)}</ul>
    {!filtered.length && <p className="demo-empty">No matching references.</p>}
  </div>;
}

function Configuration({ preview }: { preview: Preview }) {
  const yaml = preview.static ? "name: docs-site\ntype: static\ndirectory: ./site\n" : exampleYaml;
  return <div className="demo-configuration">
    <div className="demo-config-heading"><span><FileCode2 aria-hidden="true" />preview.yaml</span></div>
    <p className="demo-section-label">Source directories</p>
    <dl className="demo-source-list">{(preview.static ? ["site"] : ["frontend", "api", "reporting"]).map(source => <div key={source}><dt>{source}</dt><dd><code>{preview.path}/{source}</code></dd></div>)}</dl>
    {!preview.static && <>
      <p className="demo-section-label">Environment bindings</p>
      <table className="demo-binding-table"><thead><tr><th>Name</th><th>Type</th><th>Reference</th></tr></thead><tbody>
        <tr><th scope="row"><code>frontend.<wbr />API_URL</code></th><td>Service URL</td><td><code>api</code></td></tr>
        <tr><th scope="row"><code>frontend.<wbr />PUBLIC_API_URL</code></th><td>Browser URL</td><td><code>api</code></td></tr>
        <tr><th scope="row"><code>api.<wbr />DATABASE_URL</code></th><td>Service URL</td><td><code>database</code></td></tr>
        <tr><th scope="row"><code>api.<wbr />REDIS_URL</code></th><td>Service URL</td><td><code>cache</code></td></tr>
      </tbody></table>
    </>}
    <details className="demo-yaml"><summary>YAML</summary><pre tabIndex={0} aria-label={`${preview.project} configuration`}><code>{yaml}</code></pre></details>
  </div>;
}

function PreviewDetail({ preview }: { preview: Preview }) {
  const [view, setView] = useState<View>("activity");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(preview.failed ? "latest" : "serving");
  const [records, setRecords] = useState(initialOutput);
  const [paused, setPaused] = useState(false);
  const sequence = useRef(initialOutput.length);
  const panel = useRef<HTMLDivElement>(null);
  const logBody = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const isServing = !preview.static && (!preview.failed || attempt === "serving");
  const lines = preview.static ? [] : isServing ? records : failedOutput;
  const filtered = lines.filter(line => (source === "all" || line.source === source) && `${line.source} ${line.text}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [view]);
  useEffect(() => {
    if (view !== "logs" || !isServing || paused) return;
    const timer = setInterval(() => {
      const bounds = panel.current?.getBoundingClientRect();
      if (document.hidden || !bounds || bounds.bottom <= 0 || bounds.top >= innerHeight) return;
      const incoming = incomingOutput[(sequence.current - initialOutput.length) % incomingOutput.length];
      const line: LogLine = { ...incoming, id: ++sequence.current, stream: "stdout" };
      setRecords(previous => [...previous.slice(-59), line]);
    }, 2200);
    return () => clearInterval(timer);
  }, [view, isServing, paused]);
  useEffect(() => {
    if (followOutput.current) logBody.current?.scrollTo({ top: logBody.current.scrollHeight });
  }, [records]);

  function showLogs(name: string, nextAttempt = "serving") {
    setSource(name); setQuery(""); setAttempt(nextAttempt); setView("logs");
    requestAnimationFrame(() => document.getElementById("example-view-logs")?.focus({ preventScroll: true }));
  }
  return <>
    <div className="demo-preview-header">
      <div className="demo-identity"><div><h2>{preview.project}</h2><Status value={previewStatus(preview)} /></div><span className="demo-branch"><GitBranch aria-hidden="true" />{preview.branch}</span></div>
    </div>
    <dl className="demo-metadata"><div><dt>Project</dt><dd><code>{preview.path}</code></dd></div><div><dt>{preview.static ? "Localhost" : "Hostname"}</dt><dd className="demo-address"><code>{address(preview)}</code></dd></div></dl>
    <LandingTabs id="example-view" label="Example product views" items={views} selected={view} onSelect={setView} />
    <div ref={panel} className="demo-panel" id="example-view-panel" role="tabpanel" aria-labelledby={`example-view-${view}`} tabIndex={0}>
      <div key={view} className="demo-view-content">
        {view === "activity" && <>
          {preview.failed ? <div className="demo-attempts"><div><span>Serving</span><Status value="Ready" /></div><div><span>Latest update</span><Status value="Failed" /><button type="button" onClick={() => showLogs("migrate", "latest")}>Migration logs<ArrowRight aria-hidden="true" /></button></div><p>Migration failed. Previous preview still serving.</p></div> : <div className="demo-attempt-line"><span>Serving</span><Status value="Ready" /></div>}
          <p className="demo-section-label">{preview.static ? "Static files" : "Services · Serving"}</p>
          {preview.static ? <div className="demo-static"><FileCode2 aria-hidden="true" /><strong>./site</strong><Status value="Ready" /></div> : <>
            <table className="demo-services"><thead><tr><th>Service</th><th>Type</th><th>Status</th><th className="demo-connection">Connection</th><th><span className="landing-sr-only">Actions</span></th></tr></thead><tbody>{services.map(service => <tr key={service.name}>
              <th scope="row"><service.icon aria-hidden="true" /><span>{service.name}</span></th><td>{service.type}</td><td><Status value="Ready" /></td>
              <td className="demo-connection"><code>{service.type === "HTTP" ? `shared-notes--${service.name}.localhost:${preview.port}` : "Managed · this environment"}</code></td>
              <td>{service.type === "HTTP" && <button type="button" onClick={() => showLogs(service.name)} aria-label={`View ${service.name} logs`}>Logs</button>}</td>
            </tr>)}</tbody></table>
            <div className="demo-job"><div><p className="demo-section-label">Setup jobs{preview.failed ? " · Latest update" : ""}</p><span><Terminal aria-hidden="true" /><strong>migrate</strong><Status value={preview.failed ? "Failed" : "Succeeded"} /></span></div><button type="button" onClick={() => showLogs("migrate", preview.failed ? "latest" : "serving")} aria-label="View migration logs">Logs</button></div>
          </>}
        </>}
        {view === "logs" && <div className="demo-logs">
          <div className="demo-log-controls">
            <label className="demo-search"><Search aria-hidden="true" /><input aria-label="Search example logs" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search logs…" type="search" /></label>
            <DemoSelect label="Log attempt" value={attempt} onChange={setAttempt} options={preview.failed ? [{ id: "latest", label: "Latest update" }, { id: "serving", label: "Serving" }] : [{ id: "serving", label: "Serving" }]} />
            <DemoSelect label="Log source" value={source} onChange={setSource} options={[{ id: "all", label: "All output" }, ...(!preview.static ? [...services.map(service => ({ id: service.name, label: service.name })), { id: "migrate", label: "migrate" }] : [])]} />
          </div>
          <div className="demo-log-heading"><span>stdout / stderr</span>{isServing && <button type="button" aria-label={paused ? "Resume demo log playback" : "Pause demo log playback"} onClick={() => setPaused(value => !value)}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}{paused ? "Resume playback" : "Pause playback"}</button>}</div>
          <div ref={logBody} className="demo-log-output" tabIndex={0} aria-label="Example log output" onScroll={event => {
            const element = event.currentTarget;
            followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          }}>
            {filtered.length ? filtered.map(line => <div key={line.id} className="demo-log-line" data-stream={line.stream}><span>{String(line.id).padStart(2, "0")}</span><code>{line.source}</code><pre>{line.text}</pre></div>) : <p className="demo-empty">{preview.static ? "No process output." : "No matching output."}</p>}
          </div>
        </div>}
        {view === "configuration" && <Configuration preview={preview} />}
      </div>
    </div>
  </>;
}

export function ProductDemo() {
  const [selection, setSelection] = useState<Selection>("notes-main");
  function selectPreview(id: Selection, focus = false) {
    setSelection(id);
    if (focus) requestAnimationFrame(() => document.getElementById("example-view-activity")?.focus({ preventScroll: true }));
  }
  const preview = previews.find(preview => preview.id === selection) ?? previews[0];
  return <section id="product-demo" className="product-demo" aria-label="Interactive Previewhost example" aria-describedby="demo-disclosure">
    <div className="demo-window">
      <aside className="demo-sidebar" aria-label="Example preview navigation">
        <div className="demo-brand"><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} /><strong>Previewhost</strong></div>
        <button className="demo-overview-button" type="button" aria-pressed={selection === "overview"} onClick={() => selectPreview("overview")}><Grid2X2 aria-hidden="true" />Overview<span>3</span></button>
        <button className="demo-overview-button" type="button" aria-pressed={selection === "secrets"} onClick={() => selectPreview("secrets")}><KeyRound aria-hidden="true" />Secret Manager</button>
        {["shared-notes", "docs-site"].map(project => <div className="demo-project-group" key={project}><p className="demo-sidebar-label">{project}</p>{previews.filter(preview => preview.project === project).map(preview => <button key={preview.id} type="button" className="demo-preview-button" aria-label={`${preview.project} ${preview.branch} ${previewStatus(preview)}`} aria-pressed={selection === preview.id} onClick={() => selectPreview(preview.id)}><span><GitBranch aria-hidden="true" />{preview.branch}</span><Status value={previewStatus(preview)} /></button>)}</div>)}
      </aside>
      <div className="demo-workspace">
        <div className="demo-mobile-select"><DemoSelect label="Choose preview" value={selection} onChange={selectPreview} options={[{ id: "overview", label: "Overview" }, ...previews.map(preview => ({ id: preview.id, label: `${preview.project} / ${preview.branch}` })), { id: "secrets", label: "Secret Manager" }]} /></div>
        {selection === "overview" ? <div className="demo-overview"><h2>Overview</h2><div className="demo-overview-list">{previews.map(preview => <button key={preview.id} type="button" onClick={() => selectPreview(preview.id, true)}><span><strong>{preview.project}</strong><span className="demo-branch"><GitBranch aria-hidden="true" />{preview.branch}</span><code>{preview.path}</code></span><Status value={previewStatus(preview)} /><ChevronRight aria-hidden="true" /></button>)}</div></div>
          : selection === "secrets" ? <SecretManager /> : <PreviewDetail key={preview.id} preview={preview} />}
      </div>
    </div>
    <p id="demo-disclosure" className="demo-disclosure">Interactive demo · simulated data</p>
    <noscript><p className="demo-noscript">Enable JavaScript to use the demo.</p></noscript>
  </section>;
}
