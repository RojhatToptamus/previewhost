import { Check, ChevronRight, Code2, Copy, Database, FileCode2, GitBranch, Grid2X2, KeyRound, Layers, Pause, Play, Search, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import brandSvg from "../../assets/previewhost.svg?raw";
import exampleYaml from "./inventory.yaml?raw";
import { LandingTabs } from "./landing-tabs";
import { DemoSelect } from "./demo-select";
import { copyText } from "./clipboard";
import "./product-demo.css";

const mark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");
const previews = [
  { id: "inventory-main", project: "inventory", branch: "main", path: "~/code/inventory", port: 49837 },
  { id: "inventory-stock", project: "inventory", branch: "feature/stock-alerts", path: "~/worktrees/inventory-stock-alerts", port: 49902 },
  { id: "booking-main", project: "booking", branch: "main", path: "~/code/booking", port: 49961 },
] as const;
type Preview = (typeof previews)[number];
type Selection = Preview["id"] | "overview" | "secrets";
type View = "activity" | "logs" | "configuration";
const views = [{ id: "activity", label: "Activity" }, { id: "logs", label: "Logs" }, { id: "configuration", label: "Configuration" }] as const;
const services = [
  { name: "frontend", type: "HTTP", runtime: "Next.js", icon: Code2 },
  { name: "api", type: "HTTP", runtime: "FastAPI", icon: Terminal },
  { name: "database", type: "PostgreSQL", runtime: "PostgreSQL", icon: Database },
  { name: "cache", type: "Redis", runtime: "Redis", icon: Layers },
];
type LogLine = { id: number; source: string; text: string };

// Representative Next.js, Uvicorn and Alembic output. No local processes run here.
function initialOutput(project: Preview["project"]): LogLine[] {
  return [
    { id: 1, source: "migrate", text: "INFO [alembic.runtime.migration] Context impl PostgresqlImpl." },
    { id: 2, source: "migrate", text: `INFO [alembic.runtime.migration] Running upgrade -> 001, create ${project === "inventory" ? "products and stock_movements" : "rooms and reservations"}` },
    { id: 3, source: "api", text: "INFO: Waiting for application startup." },
    { id: 4, source: "api", text: "INFO: Application startup complete." },
    { id: 5, source: "frontend", text: "✓ Starting..." },
    { id: 6, source: "frontend", text: "✓ Ready in 842ms" },
    ...requestOutput(project).slice(0, 2).map((line, index) => ({ ...line, id: 7 + index })),
  ];
}

function requestOutput(project: Preview["project"]) {
  return project === "inventory" ? [
    { source: "api", text: 'INFO: 127.0.0.1:53124 - "GET /products?warehouse=main HTTP/1.1" 200 OK' },
    { source: "frontend", text: "GET /inventory 200 in 38ms" },
    { source: "api", text: 'INFO: 127.0.0.1:53124 - "POST /stock-movements HTTP/1.1" 201 Created' },
    { source: "api", text: "INFO: inventory.stock: SKU-1042 received +12 units; stock cache invalidated" },
    { source: "api", text: 'INFO: 127.0.0.1:53124 - "GET /products/SKU-1042 HTTP/1.1" 200 OK' },
    { source: "frontend", text: "GET /inventory/SKU-1042 200 in 24ms" },
  ] : [
    { source: "api", text: 'INFO: 127.0.0.1:53218 - "GET /availability?room=studio HTTP/1.1" 200 OK' },
    { source: "frontend", text: "GET /rooms/studio 200 in 31ms" },
    { source: "api", text: 'INFO: 127.0.0.1:53218 - "POST /reservations HTTP/1.1" 201 Created' },
    { source: "api", text: "INFO: booking.reservations: reservation confirmed; availability cache invalidated" },
    { source: "api", text: 'INFO: 127.0.0.1:53218 - "GET /availability?room=studio HTTP/1.1" 200 OK' },
    { source: "frontend", text: "GET /reservations 200 in 22ms" },
  ];
}
const references = ["inventory/dev/api-token", "booking/dev/api-token"];
const address = (preview: Preview) => `${preview.project}--frontend.localhost:${preview.port}`;
const logTime = (id: number) => new Date(Date.UTC(2026, 0, 1, 9, 41, id * 2)).toISOString().slice(11, 19);

function Status({ value }: { value: string }) {
  return <span className="demo-status" data-tone={value === "Ready" || value === "Succeeded" ? "success" : "muted"}>{value}</span>;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="demo-copy-value"><button type="button" title={status === "copied" ? "Copied" : label} aria-label={label} onClick={async () => {
    clearTimeout(timer.current);
    try { await copyText(value); setStatus("copied"); timer.current = setTimeout(() => setStatus("idle"), 2000); }
    catch { setStatus("error"); }
  }}>{status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button><span role="status" className={status === "error" ? "demo-copy-error" : "landing-sr-only"}>{status === "copied" ? "Copied." : status === "error" ? "Copy failed. Select and copy the text." : ""}</span></span>;
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
  const yaml = exampleYaml.replaceAll("inventory", preview.project);
  return <div className="demo-configuration">
    <div className="demo-config-heading"><span><FileCode2 aria-hidden="true" />Requested configuration</span></div>
    <p className="demo-section-label">Source directories</p>
    <dl className="demo-source-list">{["frontend", "api"].map(source => <div key={source}><dt>{source}</dt><dd><code>{preview.path}/{source}</code></dd></div>)}</dl>
      <p className="demo-section-label">Environment bindings</p>
      <table className="demo-binding-table"><thead><tr><th>Name</th><th>Type</th><th>Reference</th></tr></thead><tbody>
        <tr><th scope="row"><code>frontend.<wbr />API_URL</code></th><td>Service URL</td><td><code>api</code></td></tr>
        <tr><th scope="row"><code>frontend.<wbr />NEXT_PUBLIC_API_URL</code></th><td>Browser URL</td><td><code>api</code></td></tr>
        <tr><th scope="row"><code>api.<wbr />DATABASE_URL</code></th><td>Service URL</td><td><code>database</code></td></tr>
        <tr><th scope="row"><code>api.<wbr />REDIS_URL</code></th><td>Service URL</td><td><code>cache</code></td></tr>
      </tbody></table>
    <details className="demo-yaml"><summary>YAML</summary><pre tabIndex={0} aria-label={`${preview.project} configuration`}><code>{yaml}</code></pre></details>
  </div>;
}

function PreviewDetail({ preview }: { preview: Preview }) {
  const [view, setView] = useState<View>("activity");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState(() => initialOutput(preview.project));
  const [paused, setPaused] = useState(false);
  const sequence = useRef(records.length);
  const panel = useRef<HTMLDivElement>(null);
  const logBody = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const filtered = records.filter(line => (source === "all" || line.source === source) && `${line.source} ${line.text}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [view]);
  useEffect(() => {
    if (view !== "logs" || paused) return;
    const timer = setInterval(() => {
      const bounds = panel.current?.getBoundingClientRect();
      if (document.hidden || !bounds || bounds.bottom <= 0 || bounds.top >= innerHeight) return;
      const requests = requestOutput(preview.project);
      // The first six lines are startup output; the remaining lines follow this request cycle.
      const incoming = requests[(sequence.current - 6) % requests.length];
      const line: LogLine = { ...incoming, id: ++sequence.current };
      setRecords(previous => [...previous.slice(-59), line]);
    }, 2200);
    return () => clearInterval(timer);
  }, [view, paused, preview.project]);
  useEffect(() => {
    if (followOutput.current) logBody.current?.scrollTo({ top: logBody.current.scrollHeight });
  }, [records, view, source]);

  function showLogs(name: string) {
    followOutput.current = true;
    setSource(name); setQuery(""); setView("logs");
    requestAnimationFrame(() => document.getElementById("example-view-logs")?.focus({ preventScroll: true }));
  }
  return <>
    <div className="demo-preview-header">
      <div className="demo-identity"><div><h2>{preview.project}</h2><Status value="Ready" /></div><span className="demo-branch"><GitBranch aria-hidden="true" />{preview.branch}</span></div>
    </div>
    <dl className="demo-metadata">
      <div className="demo-project-path"><dt>Project folder</dt><dd><code title={preview.path}>{preview.path}</code><CopyValue value={preview.path} label="Copy project folder" /></dd></div>
      <div><dt>Hostname</dt><dd className="demo-address"><code title={address(preview)}>{address(preview)}</code><CopyValue value={`http://${address(preview)}`} label="Copy hostname URL" /></dd></div>
      <div><dt>Localhost</dt><dd className="demo-localhost"><code>127.0.0.1:{preview.port}</code><CopyValue value={`http://127.0.0.1:${preview.port}`} label="Copy localhost URL" /></dd></div>
    </dl>
    <LandingTabs id="example-view" label="Example product views" items={views} selected={view} onSelect={setView} />
    <div ref={panel} className="demo-panel" id="example-view-panel" role="tabpanel" aria-labelledby={`example-view-${view}`} tabIndex={0}>
      <div key={view} className="demo-view-content">
        {view === "activity" && <>
          <div className="demo-attempt-line"><span>Serving</span><Status value="Ready" /></div>
          <p className="demo-section-label">Services · Serving</p>
            <table className="demo-services"><thead><tr><th>Service</th><th>Runtime</th><th>Status</th><th className="demo-connection">Connection</th><th><span className="landing-sr-only">Actions</span></th></tr></thead><tbody>{services.map(service => <tr key={service.name}>
              <th scope="row"><service.icon aria-hidden="true" /><span>{service.name}</span></th><td>{service.runtime}</td><td><Status value="Ready" /></td>
              <td className="demo-connection"><code>{service.type === "HTTP" ? `${preview.project}--${service.name}.localhost:${preview.port}` : "Managed · this environment"}</code></td>
              <td>{service.type === "HTTP" && <button type="button" onClick={() => showLogs(service.name)} aria-label={`View ${service.name} logs`}>Logs</button>}</td>
            </tr>)}</tbody></table>
          <div className="demo-job"><div><p className="demo-section-label">Setup jobs</p><span><Terminal aria-hidden="true" /><strong>migrate</strong><Status value="Succeeded" /></span></div><button type="button" onClick={() => showLogs("migrate")} aria-label="View migration logs">Logs</button></div>
        </>}
        {view === "logs" && <div className="demo-logs">
          <div className="demo-log-controls">
            <label className="demo-search"><Search aria-hidden="true" /><input aria-label="Search example logs" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search logs…" type="search" /></label>
            <DemoSelect label="Log source" value={source} onChange={value => { followOutput.current = true; setSource(value); }} options={[{ id: "all", label: "All output" }, { id: "frontend", label: "frontend" }, { id: "api", label: "api" }, { id: "migrate", label: "migrate" }]} />
          </div>
          <div className="demo-log-heading"><span>stdout / stderr</span><button type="button" aria-label={paused ? "Resume demo log playback" : "Pause demo log playback"} onClick={() => setPaused(value => !value)}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}{paused ? "Resume playback" : "Pause playback"}</button></div>
          <div ref={logBody} className="demo-log-output" tabIndex={0} aria-label="Example log output" onScroll={event => {
            const element = event.currentTarget;
            followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          }}>
            {filtered.length ? filtered.map(line => <div key={line.id} className="demo-log-line"><time>{logTime(line.id)}</time><code>{line.source}</code><pre>{line.text}</pre></div>) : <p className="demo-empty">No matching output.</p>}
          </div>
        </div>}
        {view === "configuration" && <Configuration preview={preview} />}
      </div>
    </div>
  </>;
}

export function ProductDemo() {
  const [selection, setSelection] = useState<Selection>("inventory-main");
  const [openProject, setOpenProject] = useState<string | undefined>("inventory");
  function selectPreview(id: Selection, focus = false) {
    setSelection(id);
    const selectedPreview = previews.find(preview => preview.id === id);
    if (selectedPreview) setOpenProject(selectedPreview.project);
    if (focus) requestAnimationFrame(() => document.getElementById("example-view-activity")?.focus({ preventScroll: true }));
  }
  const preview = previews.find(preview => preview.id === selection) ?? previews[0];
  return <section id="product-demo" className="product-demo" aria-label="Interactive Previewhost example" aria-describedby="demo-disclosure">
    <div className="demo-window">
      <aside className="demo-sidebar" aria-label="Example preview navigation">
        <div className="demo-brand"><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} /><strong>Previewhost</strong></div>
        <button className="demo-overview-button" type="button" aria-pressed={selection === "overview"} onClick={() => selectPreview("overview")}><Grid2X2 aria-hidden="true" />Overview<span>{previews.length}</span></button>
        <button className="demo-overview-button" type="button" aria-pressed={selection === "secrets"} onClick={() => selectPreview("secrets")}><KeyRound aria-hidden="true" />Secret Manager</button>
        <div className="demo-projects">{["booking", "inventory"].map(project => <div className="demo-project-group" key={project}>
          <button type="button" className="demo-project-toggle" aria-expanded={openProject === project} aria-controls={`demo-project-${project}`} onClick={() => setOpenProject(openProject === project ? undefined : project)}><ChevronRight aria-hidden="true" /><span>{project}</span><span>{previews.filter(preview => preview.project === project).length}</span></button>
          <div id={`demo-project-${project}`} hidden={openProject !== project}>
            {previews.filter(preview => preview.project === project).sort((a, b) => a.branch.localeCompare(b.branch)).map(preview => <button key={preview.id} type="button" className="demo-preview-button" aria-label={`${preview.project} ${preview.branch} Ready`} aria-pressed={selection === preview.id} onClick={() => selectPreview(preview.id)}><span>{preview.branch}</span><Status value="Ready" /></button>)}
          </div>
        </div>)}</div>
      </aside>
      <div className="demo-workspace">
        <div className="demo-mobile-select"><DemoSelect label="Choose preview" value={selection} onChange={selectPreview} options={[{ id: "overview", label: "Overview" }, ...previews.map(preview => ({ id: preview.id, label: `${preview.project} / ${preview.branch}` })), { id: "secrets", label: "Secret Manager" }]} /></div>
        {selection === "overview" ? <div className="demo-overview"><h2>Overview</h2><div className="demo-overview-list">{previews.map(preview => <button key={preview.id} type="button" onClick={() => selectPreview(preview.id, true)}><span><strong>{preview.project}</strong><span className="demo-branch"><GitBranch aria-hidden="true" />{preview.branch}</span><code>{preview.path}</code></span><Status value="Ready" /><ChevronRight aria-hidden="true" /></button>)}</div></div>
          : selection === "secrets" ? <SecretManager /> : <PreviewDetail key={preview.id} preview={preview} />}
      </div>
    </div>
    <p id="demo-disclosure" className="demo-disclosure">Interactive demo · simulated data</p>
    <noscript><p className="demo-noscript">Enable JavaScript to use the demo.</p></noscript>
  </section>;
}
