import { ArrowDown, ArrowRight, ArrowUpRight, Check, Copy, Database, Layers, Menu, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import brandSvg from "../../assets/previewhost.svg?raw";
import { copyText } from "./clipboard";
import { pageHref } from "./pages";
import { SiteThemeToggle, useSiteTheme } from "./siteTheme";
import { LandingTabs } from "./landing-tabs";
import { ProductDemo } from "./product-demo";
import "./landing.css";

const github = "https://github.com/RojhatToptamus/previewhost";
const brandMark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");
const interfaces = [{ id: "cli", label: "CLI" }, { id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }, { id: "cursor", label: "Cursor" }] as const;
type Interface = (typeof interfaces)[number]["id"];
const agentCommands = {
  codex: "codex mcp add previewhost -- previewhost mcp --allow-exec",
  claude: "claude mcp add --scope user previewhost -- previewhost mcp --allow-exec",
  cursor: '{\n  "mcpServers": {\n    "previewhost": {\n      "type": "stdio",\n      "command": "previewhost",\n      "args": ["mcp", "--allow-exec"]\n    }\n  }\n}',
};

function Brand() {
  return <a className="landing-brand" href={import.meta.env.BASE_URL} aria-label="Previewhost home"><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: brandMark }} /><span>Previewhost</span></a>;
}
function TextLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return <a className={`landing-text-link ${className}`} href={href}>{children}<ArrowRight aria-hidden="true" /></a>;
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div className="landing-command-wrap"><div className="landing-command"><code>{command}</code><button type="button" aria-label={`Copy ${label}`} onClick={async () => {
    clearTimeout(timer.current);
    try { await copyText(command); setStatus("copied"); timer.current = setTimeout(() => setStatus("idle"), 1800); }
    catch { setStatus("error"); }
  }}>{status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}<span>{status === "copied" ? "Copied" : "Copy"}</span></button></div><span className={status === "error" ? "landing-copy-error" : "landing-sr-only"} role="status">{status === "copied" ? "Copied." : status === "error" ? "Copy failed. Select the text and copy it manually." : ""}</span></div>;
}

function DependencyDiagram() {
  const diagram = useRef<HTMLDivElement>(null);
  const [hasEntered, setHasEntered] = useState(false);
  useEffect(() => {
    if (!diagram.current || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setHasEntered(true);
        observer.disconnect();
      }
    }, { threshold: .25 });
    observer.observe(diagram.current);
    return () => observer.disconnect();
  }, []);
  const connections = [
    { name: "database", path: "M110 56V82" },
    { name: "cache", path: "M330 56V142Q330 152 320 152H230Q220 152 220 162V164" },
    { name: "migration", path: "M110 138V142Q110 152 120 152H210Q220 152 220 162V164" },
    { name: "frontend", path: "M220 220V246" },
  ];
  return <div ref={diagram} className="landing-dependencies" data-entered={hasEntered} role="img" aria-label="Example startup dependencies: PostgreSQL before migrate; migrate and Redis before the FastAPI API; the API before the Next.js frontend. The frontend receives the preview URL.">
    <span className="landing-diagram-label">Startup order</span>
    <div className="landing-dependency-grid" aria-hidden="true">
      <svg className="dependency-connections" viewBox="0 0 440 302" preserveAspectRatio="none" aria-hidden="true">{connections.map(connection => <g key={connection.name} data-connection={connection.name}><path d={connection.path} className="dependency-path" /><path d={connection.path} className="dependency-signal" pathLength="1" /></g>)}</svg>
      <div className="dependency-node dependency-db"><Database /><div><strong>database</strong><span>PostgreSQL</span></div></div>
      <div className="dependency-node dependency-cache"><Layers /><div><strong>cache</strong><span>Redis</span></div></div>
      <div className="dependency-down dependency-db-arrow"><ArrowDown /></div>
      <div className="dependency-node dependency-migrate"><Terminal /><div><strong>migrate</strong><span>Setup job</span></div></div>
      <div className="dependency-node dependency-api"><Terminal /><div><strong>api</strong><span>FastAPI</span></div></div>
      <div className="dependency-down dependency-api-arrow"><ArrowDown /></div>
      <div className="dependency-node dependency-frontend"><Terminal /><div><strong>frontend</strong><span>Next.js · local preview URL</span></div></div>
    </div>
  </div>;
}

function Capabilities() {
  return <section id="how-it-works" className="landing-section landing-width" aria-labelledby="workflow-heading">
    <div className="landing-section-intro"><h2 id="workflow-heading">Start services in dependency order.</h2><p>One <code>preview.yaml</code> connects your frontend, API, setup jobs, and databases. Previewhost starts each service after its dependencies are ready.</p></div>
    <div className="landing-workflow-detail">
      <div className="landing-config-example">
        <div className="landing-code-heading"><span>preview.yaml</span><span>API excerpt</span></div>
        <pre tabIndex={0} aria-label="API startup configuration"><code>{'api:\n  type: command\n  cwd: ./api\n  command: [python, -m, uvicorn, app:app,\n    --host, 127.0.0.1, --port, "{port}"]\n  readyPath: /health\n  dependsOn: [migrate]\n  env:\n    DATABASE_URL: {service: database}\n    REDIS_URL: {service: cache}'}</code></pre>
        <p>The API starts after its migration and databases are ready.</p>
        <TextLink href={pageHref("services-and-jobs", "define-services-and-jobs")}>Services and setup jobs</TextLink>
      </div>
      <DependencyDiagram />
    </div>
    <div className="landing-benefits">
      <article><span>01</span><h3>Run worktrees side by side</h3><p>Run environments for different worktrees, each with separate ports, local URLs, and managed database data.</p><TextLink href={pageHref("worktrees")}>Worktree isolation</TextLink></article>
      <article><span>02</span><h3>Connect different repositories</h3><p>Point the frontend and APIs at their existing source directories. Combine them in one environment, even when their branch names differ.</p><TextLink href={`${github}/tree/main/examples/multi-repo`}>Multi-repository example</TextLink></article>
      <article><span>03</span><h3>Inspect service logs in one place</h3><p>Read frontend, API, and setup-job output in one view. Filter by source or attempt, then refresh for new output.</p><TextLink href={pageHref("dashboard", "read-logs")}>Service and job logs</TextLink></article>
    </div>
    <p className="landing-limit">Logs capture command and job output. Database container logs are not collected. Browser-console messages appear only when your framework forwards them to a captured process.</p>
  </section>;
}

function Bindings() {
  return <section className="landing-bindings" aria-labelledby="bindings-heading"><div className="landing-width">
    <div className="landing-binding-grid">
      <div className="landing-binding-copy"><p className="landing-section-label">Configuration and private setup</p><h2 id="bindings-heading">Use named connections.<br />Keep secrets out of config.</h2><p>Bind environment variables to services, selected host inputs, or stored secret references.</p><ol className="landing-secret-flow"><li><span>1</span><p>Your agent declares the secret references and services that need them.</p></li><li><span>2</span><p>You approve access and enter missing values in a private form, outside your agent chat.</p></li><li><span>3</span><p>Services receive approved values at startup. Stored-secret bindings stay as references in saved configuration.</p></li></ol><TextLink href={pageHref("secrets")}>Private setup and secret access</TextLink><p className="landing-caveat">Application code can still expose values. Log redaction is best effort.</p></div>
      <div className="landing-binding-example"><div className="landing-code-heading"><span>preview.yaml</span><span>API service excerpt</span></div><pre tabIndex={0} aria-label="Example environment bindings"><code>{'api:\n  type: command\n  cwd: ./api\n  command: [python, -m, uvicorn, app:app,\n    --host, 127.0.0.1, --port, "{port}"]\n  env:\n    DATABASE_URL: {service: database}\n    REDIS_URL: {service: cache}\n    API_TOKEN: {secret: "inventory/dev/api-token"}\n    REGION: {fromEnv: REGION}'}</code></pre><dl><div><dt><code>service</code></dt><dd>A connection URL, plus a readiness dependency.</dd></div><div><dt><code>secret</code></dt><dd>A stored reference, shared wherever that exact name is approved.</dd></div><div><dt><code>fromEnv</code></dt><dd>A host variable selected with <code>--env</code> at startup.</dd></div></dl><p>For browser requests, <code>{'{browserUrl: api}'}</code> supplies an HTTP alias without a startup dependency.</p></div>
    </div>
    <div className="landing-config-options"><div><h3>Describe the app you have.</h3><p>Save <code>preview.yaml</code>, pass JSON to the CLI, or let your agent supply a configuration. You choose the commands and readiness checks.</p><TextLink href={pageHref("configuration")}>Configuration guide</TextLink></div><dl><div><dt>Static files</dt><dd>Prepared HTML, assets, and build output.</dd></div><div><dt>HTTP applications</dt><dd>Your installed development server or application command.</dd></div><div><dt>Existing local servers</dt><dd>Connect by HTTP URL. The existing server’s process, port, and data stay under its original owner.</dd></div><div><dt>Services and setup jobs</dt><dd>HTTP services, managed or existing local PostgreSQL and Redis, and setup jobs that run to completion.</dd></div></dl></div>
    <p className="landing-limit">Install your app’s dependencies before startup. Managed databases require <a href={pageHref("databases", "prepare-docker")}>local Docker and downloaded images</a>. Non-HTTP background workers are not supported.</p>
  </div></section>;
}

function GetStarted() {
  const [selected, setSelected] = useState<Interface>("cli");
  const name = interfaces.find(item => item.id === selected)!.label;
  return <section id="get-started" className="landing-start site-dark-surface" aria-labelledby="start-heading"><div className="landing-width">
    <div className="landing-start-heading"><div><p className="landing-section-label">CLI and coding agents</p><h2 id="start-heading">Choose your interface.</h2></div><p>Node.js 22.23 or later.<br />macOS, Linux, and Windows.<br /><a href={pageHref("installation", "requirements")}>Installation requirements<ArrowUpRight aria-hidden="true" /></a></p></div>
    <div className="landing-install-row"><h3><span>01</span>Install Previewhost</h3><CopyCommand label="install command" command="npm install -g previewhost" /></div>
    <div className="landing-setup">
      <div className="landing-setup-heading"><span>02</span><p>Run it from your terminal, or connect your coding agent through MCP.</p></div>
      <LandingTabs id="setup" label="Setup interface" items={interfaces} selected={selected} onSelect={setSelected} />
      <div id="setup-panel" role="tabpanel" aria-labelledby={`setup-${selected}`} tabIndex={0}>
        {selected === "cli" ? <div className="landing-setup-content"><div><h3>Start from your project directory.</h3><p>Install your app’s dependencies and <a href={pageHref("configuration")}>create preview.yaml</a> with its start commands and connections.</p><p>For managed databases or stored secrets, first complete private setup:</p><CopyCommand label="private setup command" command="previewhost secrets setup --allow-exec" /><TextLink href={pageHref("first-preview")}>Follow the CLI quickstart</TextLink></div><div className="landing-setup-commands"><p>Inspect the configuration, then start:</p><CopyCommand label="inspect and start commands" command={'previewhost inspect\npreviewhost start --allow-exec'} /><p>Open the returned URL. In another terminal, inspect your environments:</p><CopyCommand label="dashboard command" command="previewhost dashboard" /><p className="landing-small">Keep the dashboard terminal open while using it.</p></div></div>
          : <div className="landing-setup-content landing-agent-setup"><div><h3>{selected === "cursor" ? "Add Previewhost to Cursor." : `Register Previewhost with ${name}.`}</h3>{selected === "cursor" ? <p>Add this entry to <code>~/.cursor/mcp.json</code>, preserving other servers. Enable Previewhost in Cursor’s MCP settings.</p> : <p>Run the registration command in your terminal. One registration works across your projects.</p>}</div><div className="landing-setup-commands"><p>{selected === "cursor" ? "~/.cursor/mcp.json" : "Register the MCP server:"}</p><CopyCommand key={selected} label={`${name} ${selected === "cursor" ? "configuration" : "MCP command"}`} command={agentCommands[selected]} /></div><div className="landing-setup-next"><h3>Then ask for a preview.</h3><p>In your project chat:</p><CopyCommand label="agent prompt" command={'Preview this application with Previewhost. Read its instructions and start commands,\nreuse the project configuration if present, and verify the returned URL in a browser.'} /><p>Approve project access. Complete private setup if asked, then tell your agent to continue.</p><TextLink href={pageHref("mcp")}>MCP setup guide</TextLink></div><p className="landing-agent-capabilities">Your agent can start previews, inspect status and captured logs, and stop previews. They keep running when the agent pauses.</p></div>}
      </div>
      <p className="landing-permissions"><code>--allow-exec</code> permits trusted commands with your user permissions. It does not sandbox code or approve secrets.</p>
    </div>
  </div></section>;
}

export function LandingPage() {
  const { theme, toggleTheme } = useSiteTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  return <div className="landing"><a className="landing-skip" href="#main-content">Skip to content</a>
    <header className="landing-header" onKeyDown={event => { if (event.key === "Escape" && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}>
      <div className="landing-width landing-header-inner"><Brand /><nav className="landing-nav" id="landing-navigation" aria-label="Main navigation" data-open={menuOpen} onClick={() => setMenuOpen(false)}><a href="#how-it-works">Why Previewhost</a><a href={pageHref("welcome")}>Docs</a><a href={github}>GitHub<ArrowUpRight aria-hidden="true" /></a></nav><div className="landing-header-actions"><SiteThemeToggle theme={theme} onToggle={toggleTheme} compact /><a className="landing-button landing-header-cta" href="#get-started">Get started</a><button className="landing-menu" ref={menuButton} type="button" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="landing-navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button></div></div>
    </header>
    <main id="main-content"><section className="landing-hero" aria-labelledby="hero-heading"><div className="landing-width"><div className="landing-hero-copy"><h1 id="hero-heading">Local previews<br /> for full-stack apps.</h1><p>Start your frontend, API, and databases on your machine. Previewhost assigns local URLs, starts services in dependency order, and separates each environment’s ports and managed data. Use the CLI, or connect your coding agent over MCP.</p><div className="landing-hero-actions"><CopyCommand label="quick install command" command="npm install -g previewhost" /><TextLink href="#get-started">Choose your interface</TextLink></div><p className="landing-hero-note"><a href={`${github}/blob/main/LICENSE`}>Open source</a><span aria-hidden="true">·</span>Runs on your machine</p></div><ProductDemo /></div></section><Capabilities /><Bindings /><GetStarted /></main>
    <footer className="landing-footer landing-width"><div><Brand /><p>Local previews for apps and services.</p><small>Open source (MIT).</small></div><nav aria-label="Documentation links"><span>Documentation</span><a href={pageHref("welcome")}>Introduction</a><a href={pageHref("installation")}>Installation</a><a href={pageHref("mcp")}>MCP setup</a><a href={pageHref("library")}>Node.js library</a></nav><nav aria-label="Project links"><span>Project</span><a href={github}>GitHub</a><a href="https://www.npmjs.com/package/previewhost">npm</a><a href={`${github}/blob/main/LICENSE`}>MIT license</a></nav></footer>
  </div>;
}
