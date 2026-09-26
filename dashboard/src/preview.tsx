import { useState } from "react";
import type { AttemptSummary } from "../../src/contracts";
import type { Mutate } from "./lib/api";
import { attempts, hint, shortProject, state, type Entry } from "./lib/model";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { AppLink, CopyButton, Notice, Path, Status } from "./components/shared";
import { previewActions, PreviewMenu } from "./preview-actions";
import { Activity } from "./activity";
import { Diagnostics } from "./diagnostics";
import { ConfigurationPanel } from "./configuration";
import type { LaunchResult } from "./preview-workflow";
import { usePreviewView, type PreviewView } from "./lib/view-state";

export function Preview({
  entry,
  mutate,
  acting,
  revision,
  onRefresh,
  onStarted,
  onPrepare,
}: {
  entry: Entry;
  mutate: Mutate;
  acting: boolean;
  revision: number;
  onRefresh(): void;
  onStarted(result: LaunchResult): void;
  onPrepare(resumeId?: string): void;
}) {
  const [view, updateView] = usePreviewView(entry.owner.id, entry.name);
  const [configurationVisited, setConfigurationVisited] = useState(view.tab === "configuration");
  const { attemptId, clearAfter, source, query, wrapLogs, showContext } = view;
  const { owner, preview: p } = entry;
  const retained = attempts(p);
  const reviews = owner.reviews?.filter(review => review.name === entry.name) ?? [];
  const tab = !retained.length && view.tab === "logs" ? "activity" : view.tab;
  const selected = attemptId
    ? retained.find((attempt) => attempt.id === attemptId)
    : retained[0];
  const actions = previewActions(entry);
  const canOpen = Boolean(p?.active && p.url);
  const hostnameUrl = canOpen
    ? Object.values(p?.active?.services ?? {}).find(service => service.url === p?.url)?.browserUrl
    : undefined;
  const addresses = canOpen ? [
    ...(hostnameUrl && hostnameUrl !== p!.url ? [{ label: "Hostname", url: hostnameUrl }] : []),
    { label: "Localhost", url: p!.url! },
  ] : [];
  const primary = !canOpen && !(reviews.length && !retained.length)
    ? actions.find((action) => !action.danger)
    : undefined;
  const context = hint(entry);
  function openLogs(attempt: AttemptSummary, name = "") {
    updateView({
      attemptId: attempt.id, clearAfter: undefined, source: name, query: "", tab: "logs",
    });
    requestAnimationFrame(() =>
      document.getElementById("tab-logs")?.focus({ preventScroll: true }),
    );
  }
  return (
    <article className="preview-detail" aria-label="Preview details">
      <div className="preview-header">
        <div className="preview-heading">
          <div className="preview-title">
            <h1>{entry.name ?? shortProject(owner)}</h1>
            <Status tone={owner.error ? "error" : state(entry).tone}>
              {owner.error ? "Unavailable" : state(entry).label}
            </Status>
          </div>
          <div className="header-actions">
            {!retained.length && <Button variant={primary ? "outline" : "default"} disabled={acting || Boolean(owner.error)} onClick={() => onPrepare(reviews.length === 1 ? reviews[0].id : undefined)}>{reviews.length ? "Continue setup" : "Prepare preview"}</Button>}
            {canOpen && <AppLink url={p!.url!} variant="default" />}
            {actions.map((action) => (
              <Button
                key={action.label}
                title={
                  action.label === "Stop"
                    ? "Stop this preview and keep its database data"
                    : undefined
                }
                disabled={acting || Boolean(owner.error)}
                variant={
                  action === primary
                    ? "default"
                    : action.danger
                      ? "destructive"
                      : "outline"
                }
                onClick={() => void mutate(action.body, action.message)}
              >
                {action.label}
              </Button>
            ))}
            <PreviewMenu
              entry={entry}
              mutate={mutate}
              acting={acting}
              managementOnly
            />
          </div>
        </div>
        {(owner.project || addresses.length > 0) && (
          <dl className="preview-metadata">
            {owner.project && (
              <div className="preview-project">
                <dt>Project folder</dt>
                <dd>
                  <Path value={owner.project} />
                  <CopyButton value={owner.project} />
                </dd>
              </div>
            )}
            {addresses.map(({ label, url }) => (
              <div className="preview-address" key={url}>
                <dt>{label}</dt>
                <dd>
                  <AppLink url={url} variant="link">
                    {url.replace(/^http:\/\//, "")}
                  </AppLink>
                  <CopyButton value={url} label={`Copy ${label.toLowerCase()} URL`} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {context && <p className="context-note">{context}</p>}
      </div>
      {owner.error && (
        <div className="page">
          <Notice title="Status unavailable" error>
            {owner.error.message}
          </Notice>
        </div>
      )}
        <Tabs
          className={owner.error ? "preview-tabs hidden" : "preview-tabs"}
          value={tab}
          onValueChange={(value) => {
            if (value === "configuration") setConfigurationVisited(true);
            updateView({
              tab: value as PreviewView["tab"],
              ...(value !== "activity" && selected ? { attemptId: selected.id } : {}),
            });
          }}
        >
          <TabsList
            variant="line"
            className="preview-tab-list"
            aria-label="Preview diagnostics"
          >
            <TabsTrigger value="activity" id="tab-activity">
              Activity
            </TabsTrigger>
            {!!retained.length && (
              <TabsTrigger value="logs" id="tab-logs">
                Logs
              </TabsTrigger>
            )}
            <TabsTrigger value="configuration" id="tab-configuration">
              Configuration
            </TabsTrigger>
          </TabsList>
          <TabsContent value="activity" className="preview-panel activity-panel scroll-panel">
            <Activity
              entry={entry}
              mutate={mutate}
              acting={acting}
              openLogs={openLogs}
            />
          </TabsContent>
          {(["logs", "configuration"] as const).map((view) => (
            <TabsContent key={view} value={view} className="preview-panel diagnostics-panel" forceMount={view === "configuration" && configurationVisited ? true : undefined}>
              {view === "configuration" && configurationVisited && !retained.length && !owner.error ? (
                <div className="diagnostic-body">
                  <Notice title={reviews.length ? "Configuration awaits review" : "No startup configuration retained"}>
                    {reviews.length ? "Continue setup to review the configuration and start the preview." : "Choose a configuration file or paste YAML/JSON using Prepare preview. Saved secrets remain available."}
                  </Notice>
                </div>
              ) : view === "configuration" && configurationVisited ? <ConfigurationPanel
                entry={entry} attemptId={p?.active?.id ?? p?.latest?.id ?? p?.candidate?.id} revision={revision} onStarted={onStarted}
                snapshot={selected && <Diagnostics entry={entry} revision={revision} onRefresh={onRefresh} clearAfter={clearAfter}
                  setClearAfter={clearAfter => updateView({ clearAfter })} tab="configuration" selected={selected}
                  retained={retained} selectAttempt={id => updateView({ attemptId: id, clearAfter: undefined, source: "" })}
                  source={source} setSource={source => updateView({ source })} query={query} setQuery={query => updateView({ query })}
                  wrapLogs={wrapLogs} setWrapLogs={wrapLogs => updateView({ wrapLogs })}
                  showContext={showContext} setShowContext={showContext => updateView({ showContext })} mutate={mutate} acting={acting} />}
              /> : tab === view && !selected && (
                <div className="diagnostic-body">
                  <Notice title="Attempt no longer retained">
                    <Button
                      variant="outline"
                      onClick={() => {
                        updateView({ attemptId: retained[0]?.id, clearAfter: undefined, source: "" });
                      }}
                    >
                      Show latest attempt
                    </Button>
                  </Notice>
                </div>
              )}
              {tab === view && view === "logs" && selected && (
                <Diagnostics
                  entry={entry}
                  revision={revision}
                  onRefresh={onRefresh}
                  clearAfter={clearAfter}
                  setClearAfter={(clearAfter) => updateView({ clearAfter })}
                  tab={view}
                  selected={selected}
                  retained={retained}
                  selectAttempt={(id) => {
                    updateView({ attemptId: id, clearAfter: undefined, source: "" });
                  }}
                  source={source}
                  setSource={(source) => updateView({ source })}
                  query={query}
                  setQuery={(query) => updateView({ query })}
                  wrapLogs={wrapLogs}
                  setWrapLogs={(wrapLogs) => updateView({ wrapLogs })}
                  showContext={showContext}
                  setShowContext={(showContext) => updateView({ showContext })}
                  mutate={mutate}
                  acting={acting}
                />
              )}
            </TabsContent>
          ))}
        </Tabs>
    </article>
  );
}
