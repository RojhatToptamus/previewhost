import type { AttemptSummary } from "../../src/contracts";
import type { Mutate } from "./lib/api";
import { attempts, hint, shortProject, state, type Entry } from "./lib/model";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { AppLink, CopyButton, Notice, Path, Status } from "./components/shared";
import { previewActions, PreviewMenu } from "./preview-actions";
import { Activity } from "./activity";
import { Diagnostics } from "./diagnostics";
import { usePreviewView, type PreviewView } from "./lib/view-state";

export function Preview({
  entry,
  mutate,
  acting,
  revision,
}: {
  entry: Entry;
  mutate: Mutate;
  acting: boolean;
  revision: number;
}) {
  const [view, updateView] = usePreviewView(entry.owner.id, entry.name);
  const { attemptId, clearAfter, source, query, wrapLogs, showContext } = view;
  const { owner, preview: p } = entry;
  const retained = attempts(p);
  const tab = retained.length ? view.tab : "activity";
  const selected = attemptId
    ? retained.find((attempt) => attempt.id === attemptId)
    : retained[0];
  const actions = previewActions(entry);
  const canOpen = Boolean(p?.active && p.url);
  const address = canOpen
    ? (Object.values(p?.active?.services ?? {}).find(
        (service) => service.url === p?.url,
      )?.browserUrl ?? p?.url)
    : undefined;
  const primary = !canOpen
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
        <div className="preview-identity">
          <div className="preview-title">
            <h1>{entry.name ?? shortProject(owner)}</h1>
            <Status tone={owner.error ? "error" : state(entry).tone}>
              {owner.error ? "Unavailable" : state(entry).label}
            </Status>
          </div>
          {owner.project && (
            <div className="identity-path">
              <Path value={owner.project} />
              <CopyButton value={owner.project} />
            </div>
          )}
          {address && (
            <div className="preview-address">
              <AppLink url={address} variant="link">
                {address.replace(/^http:\/\//, "")}
              </AppLink>
              <CopyButton
                value={address}
                label={address === p?.url ? "Copy URL" : "Copy hostname URL"}
              />
            </div>
          )}
          {context && <p className="context-note">{context}</p>}
        </div>
        <div className="header-actions">
          {canOpen && (
            <>
              <AppLink url={p!.url!} variant="default" />
              {address !== p!.url && (
                <CopyButton value={p!.url!} label="Copy URL" />
              )}
            </>
          )}
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
      {owner.error ? (
        <div className="page">
          <Notice title="Status unavailable" error>
            {owner.error.message}
          </Notice>
        </div>
      ) : (
        <Tabs
          className="preview-tabs"
          value={tab}
          onValueChange={(value) => {
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
            {!!retained.length && (
              <TabsTrigger value="configuration" id="tab-configuration">
                Configuration
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="activity" className="activity-panel scroll-panel">
            <Activity
              entry={entry}
              mutate={mutate}
              acting={acting}
              openLogs={openLogs}
            />
          </TabsContent>
          {(["logs", "configuration"] as const).map((view) => (
            <TabsContent key={view} value={view} className="diagnostics-panel">
              {tab === view && !selected && (
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
              {tab === view && selected && (
                <Diagnostics
                  entry={entry}
                  revision={revision}
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
      )}
    </article>
  );
}
