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
const example = `${github}/tree/main/examples/multi-repo`;
const brandMark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");

function Brand() {
  return <a className="landing-brand" href={import.meta.env.BASE_URL} aria-label="Previewhost home">
    <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: brandMark }} />
    <span>previewhost</span>
  </a>;
}

function TextLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return <a className={`landing-text-link ${className}`} href={href}>{children}<ArrowRight aria-hidden="true" /></a>;
}

function DependencyDiagram() {
  return <div className="landing-dependencies" role="img" aria-label="Example startup dependencies: PostgreSQL before migrate; migrate and Redis before API; API before reporting; API and reporting before frontend. The frontend receives the preview URL.">
    <span className="landing-diagram-label">Example startup order</span>
    <div className="landing-dependency-grid" aria-hidden="true">
      <div className="dependency-node dependency-db"><Database /><div><strong>database</strong><span>PostgreSQL</span></div></div>
      <div className="dependency-node dependency-cache"><Layers /><div><strong>cache</strong><span>Redis</span></div></div>
      <div className="dependency-down dependency-db-arrow"><ArrowDown /></div>
      <div className="dependency-node dependency-migrate"><Terminal /><div><strong>migrate</strong><span>Setup job</span></div></div>
      <div className="dependency-join" />
      <div className="dependency-node dependency-api"><Terminal /><div><strong>api</strong><span>HTTP service</span></div></div>
      <div className="dependency-down dependency-api-arrow"><ArrowDown /></div>
      <div className="dependency-node dependency-reporting"><Terminal /><div><strong>reporting</strong><span>HTTP service</span></div></div>
      <div className="dependency-down dependency-reporting-arrow"><ArrowDown /></div>
      <div className="dependency-node dependency-frontend"><Terminal /><div><strong>frontend</strong><span>Local preview URL</span></div></div>
    </div>
    <p>Previewhost supplies ports and connection URLs.</p>
  </div>;
}

function Workflow() {
  return <section id="how-it-works" className="landing-section landing-width" aria-labelledby="workflow-heading">
    <p className="landing-section-label">01 / How it works</p>
    <h2 id="workflow-heading">From source to a running stack.</h2>
    <ol className="landing-steps">
      <li><span>01</span><h3>Describe your services</h3><p>Keep commands and connections in <code>preview.yaml</code>.</p></li>
      <li><span>02</span><h3>Start the preview</h3><p>Services wait for their dependencies and setup jobs.</p></li>
      <li><span>03</span><h3>Open your app</h3><p>Use the local URL. Inspect the stack in the dashboard.</p></li>
    </ol>
    <div className="landing-workflow-detail">
      <div className="landing-config-example">
        <div className="landing-code-heading"><span>preview.yaml</span><span>API excerpt</span></div>
        <pre aria-label="API service configuration excerpt"><code><span className="code-key">  api:</span>{"\n"}<span className="code-key">    type:</span>{" command\n"}<span className="code-key">    cwd:</span>{" ./api\n"}<span className="code-key">    command:</span>{" [node, server.mjs]\n"}<span className="code-key">    readyPath:</span>{" /ready\n"}<span className="code-key">    dependsOn:</span>{" [migrate]\n"}<span className="code-key">    env:</span>{"\n"}<span className="code-key">      DATABASE_URL:</span>{"\n        service: database\n"}<span className="code-key">      REDIS_URL:</span>{"\n        service: cache"}</code></pre>
        <p>The API starts after its migration and databases are ready.</p>
        <TextLink href={example}>See the complete example</TextLink>
      </div>
      <DependencyDiagram />
    </div>
    <p className="landing-requirement">Use your existing source and installed app dependencies. Managed PostgreSQL and Redis need <a href={pageHref("databases", "prepare-docker")}>local Docker and downloaded images</a>.</p>
  </section>;
}

function Iteration() {
  return <section className="landing-iteration" aria-labelledby="iteration-heading">
    <div className="landing-width">
      <div className="landing-iteration-grid">
        <div className="landing-iteration-copy">
          <p className="landing-section-label">02 / Keep iterating</p>
          <h2 id="iteration-heading">Change the code.<br />Keep the URL.</h2>
          <p>Replace a running preview. New requests switch only when the replacement is ready.</p>
          <div className="landing-behavior"><h3>Stop the preview. Keep the data.</h3><p>Managed PostgreSQL and Redis data stays for the next start.</p></div>
        </div>
        <div className="landing-replacement" aria-label="Replacement outcomes">
          <div className="landing-replacement-address"><span>LOCAL PREVIEW URL</span><code>shared-notes--frontend.localhost:49837</code></div>
          <div className="landing-replacement-row"><span className="landing-result landing-result-ready">Ready</span><ArrowRight aria-hidden="true" /><div><h3>New requests use the replacement.</h3><p>The URL stays the same.</p></div></div>
          <div className="landing-replacement-row"><span className="landing-result landing-result-error">Failed</span><ArrowRight aria-hidden="true" /><div><h3>The previous preview keeps serving.</h3><p>Source changes and database writes are not rolled back.</p></div></div>
          <TextLink href="#product-demo">Try it in the interactive example</TextLink>
        </div>
      </div>
      <div className="landing-worktrees">
        <h3>Different worktrees.<br />Separate previews.</h3>
        <p>Run existing worktrees side by side, with their own ports and managed data.</p>
        <TextLink href={pageHref("worktrees")}>Read the worktree guide</TextLink>
      </div>
    </div>
  </section>;
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div className="landing-command-wrap">
    <div className="landing-command"><code>{command}</code><button type="button" aria-label={`Copy ${label}`} onClick={async () => {
      clearTimeout(timer.current);
      try {
        await copyText(command);
        setStatus("copied");
        timer.current = setTimeout(() => setStatus("idle"), 1800);
      } catch { setStatus("error"); }
    }}>{status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}<span>{status === "copied" ? "Copied" : "Copy"}</span></button></div>
    <span className={status === "error" ? "landing-copy-error" : "landing-sr-only"} role="status">{status === "copied" ? "Command copied." : status === "error" ? "Copy failed. Select the command and copy it manually." : ""}</span>
  </div>;
}

function GetStarted() {
  const [selected, setSelected] = useState<"terminal" | "agent">("terminal");
  return <section id="get-started" className="landing-start site-dark-surface" aria-labelledby="start-heading">
    <div className="landing-width landing-start-grid">
      <div className="landing-start-copy"><h2 id="start-heading">Start with your<br />next change.</h2><p>From your terminal or your coding agent.</p><div className="landing-platforms">Node.js 22.23+ · macOS, Linux, Windows</div><TextLink href={pageHref("installation", "requirements")}>Installation requirements</TextLink></div>
      <div>
        <div className="landing-setup">
          <LandingTabs id="setup" label="Setup method" items={[{ id: "terminal", label: "Terminal" }, { id: "agent", label: "Coding agent" }]} selected={selected} onSelect={setSelected} />
          <div id="setup-panel" role="tabpanel" aria-labelledby={`setup-${selected}`} tabIndex={0}>
            <ol className="landing-setup-steps">
              <li><span className="landing-step-number">1</span><div><h3>Install Previewhost</h3><CopyCommand label="install command" command="npm install -g previewhost" /></div></li>
              {selected === "terminal" ? <>
                <li><span className="landing-step-number">2</span><div><h3>Configure your app</h3><p>Install your app’s dependencies, then describe its services.</p><TextLink href={pageHref("configuration")}>Create preview.yaml</TextLink><p>For managed databases, complete <a className="landing-inline-link" href={pageHref("databases", "unlock-database-credentials")}>private setup</a> first.</p></div></li>
                <li><span className="landing-step-number">3</span><div><h3>Start a preview</h3><p>From the folder containing <code>preview.yaml</code>, run:</p><CopyCommand label="start command" command="previewhost start --allow-exec" /><p>Run the dashboard in another terminal. Keep that terminal open.</p><CopyCommand label="dashboard command" command="previewhost dashboard" /></div></li>
              </> : <>
                <li><span className="landing-step-number">2</span><div><h3>Connect your coding agent</h3><p>For Codex, run:</p><CopyCommand label="Codex MCP command" command="codex mcp add previewhost -- previewhost mcp --allow-exec" /><TextLink href={pageHref("mcp", "register-a-client")}>Cursor and Claude Code setup</TextLink></div></li>
                <li><span className="landing-step-number">3</span><div><h3>Ask for a preview</h3><p className="landing-agent-prompt">“Preview this application with Previewhost. Read its start commands, reuse project configuration if present, and verify the returned URL in a browser.”</p><p>Approve project access and complete private setup if requested.</p></div></li>
              </>}
            </ol>
            <p className="landing-permissions"><code>--allow-exec</code> runs trusted commands with your user permissions, without a sandbox.</p>
          </div>
        </div>
        <TextLink className="landing-next-guide" href={pageHref(selected === "terminal" ? "first-preview" : "mcp")}>{selected === "terminal" ? "Follow the CLI quickstart" : "Read the MCP guide"}</TextLink>
      </div>
    </div>
  </section>;
}

export function LandingPage() {
  const { theme, toggleTheme } = useSiteTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  return <div className="landing">
    <a className="landing-skip" href="#main-content">Skip to content</a>
    <header className="landing-header" onKeyDown={event => {
      if (event.key === "Escape" && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
    }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}>
      <div className="landing-width landing-header-inner">
        <Brand />
        <nav className="landing-nav" id="landing-navigation" aria-label="Main navigation" data-open={menuOpen} onClick={() => setMenuOpen(false)}>
          <a href="#how-it-works">How it works</a><a href={pageHref("welcome")}>Docs</a><a href={github}>GitHub<ArrowUpRight aria-hidden="true" /></a>
        </nav>
        <div className="landing-header-actions"><SiteThemeToggle theme={theme} onToggle={toggleTheme} compact /><a className="landing-button landing-header-cta" href="#get-started">Get started</a><button className="landing-menu" ref={menuButton} type="button" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="landing-navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button></div>
      </div>
    </header>
    <main id="main-content">
      <section className="landing-hero" aria-labelledby="hero-heading">
        <div className="landing-width">
          <div className="landing-hero-copy"><h1 id="hero-heading">Your whole app.<br />One local preview.</h1><p>Run your frontend, APIs, and databases together.<br className="landing-desktop-break" /> Separate previews for every worktree. A stable URL as you iterate.</p><div className="landing-hero-actions"><a className="landing-button" href="#get-started">Get started<ArrowRight aria-hidden="true" /></a><TextLink href={pageHref("mcp")}>Connect your agent</TextLink></div><p className="landing-hero-note"><a href={`${github}/blob/main/LICENSE`}>Open source</a><span aria-hidden="true">·</span>Runs on your machine</p></div>
          <ProductDemo />
        </div>
      </section>
      <Workflow />
      <Iteration />
      <GetStarted />
    </main>
    <footer className="landing-footer landing-width">
      <div><Brand /><p>Local previews for apps and services.</p><small>Open source. MIT licensed.</small></div>
      <nav aria-label="Documentation links"><span>Documentation</span><a href={pageHref("welcome")}>Introduction</a><a href={pageHref("installation")}>Installation</a><a href={pageHref("mcp")}>MCP setup</a><a href={pageHref("library")}>Node.js library</a></nav>
      <nav aria-label="Project links"><span>Project</span><a href={github}>GitHub</a><a href="https://www.npmjs.com/package/previewhost">npm</a><a href={`${github}/blob/main/LICENSE`}>MIT license</a></nav>
    </footer>
  </div>;
}
