import { useState } from "react";
import type { AttemptSummary } from "../../src/contracts";
import type { Mutate } from "./lib/api";
import {
  attempts,
  deletionNeedsRetry,
  hint,
  needsCleanup,
  pending,
  shortProject,
  state,
  type Entry,
} from "./lib/model";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { AppLink, CopyButton, Notice, Path, Status } from "./components/shared";
import { Activity } from "./activity";
import { Diagnostics } from "./diagnostics";

export type Tab = "activity" | "logs" | "configuration";
export type PreviewAction = {
  label: string;
  danger?: boolean;
  body: object;
  message: string;
};

export function previewActions(entry: Entry): PreviewAction[] {
  const { owner, preview: p, name } = entry;
  const result: PreviewAction[] = [];
  const request = pending(entry).find((request) => request.state === "pending");
  if (request)
    result.push({
      label: "Open private form",
      body: { action: "secretsOpen", owner: owner.id, id: request.id },
      message: "Private form requested in your system browser.",
    });
  if (!p) return result;
  if (p.candidate)
    result.push({
      label: p.active ? "Cancel update" : "Cancel startup",
      danger: true,
      body: {
        action: "cancel",
        owner: owner.id,
        name,
        attemptId: p.candidate.id,
      },
      message: "The selected attempt was canceled.",
    });
  if (
    (p.active || needsCleanup(p) || p.url) &&
    !deletionNeedsRetry(p) &&
    !p.busy &&
    !owner.legacy
  )
    result.push({
      label: needsCleanup(p) ? "Retry cleanup" : "Stop",
      danger: !needsCleanup(p),
      body: {
        action: "stop",
        owner: owner.id,
        name,
        expected: {
          active: p.active?.id ?? null,
          candidate: p.candidate?.id ?? null,
          latest: p.latest?.id ?? null,
        },
      },
      message: "Preview stopped. Your database data is retained.",
    });
  if (
    !p.active &&
    !p.busy &&
    !p.candidate &&
    ["stopped", "failed"].includes(p.latest?.state ?? "") &&
    !owner.legacy &&
    !needsCleanup(p)
  )
    result.push({
      label: p.latest?.state === "failed" ? "Retry start" : "Start preview",
      body: {
        action: "startAgain",
        owner: owner.id,
        name,
        attemptId: p.latest!.id,
      },
      message:
        "Startup requested with the same configuration and current source.",
    });
  return result;
}

export function Preview({
  entry,
  mutate,
  acting,
}: {
  entry: Entry;
  mutate: Mutate;
  acting: boolean;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const [attemptId, setAttemptId] = useState<string>();
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const { owner, preview: p } = entry;
  const retained = attempts(p);
  const selected =
    retained.find((attempt) => attempt.id === attemptId) ?? retained[0];
  const actions = previewActions(entry);
  const canOpen = Boolean(p?.active && p.url);
  const primary = !canOpen
    ? actions.find((action) => !action.danger)
    : undefined;
  function openLogs(attempt: AttemptSummary, name = "") {
    setAttemptId(attempt.id);
    setSource(name);
    setQuery("");
    setTab("logs");
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
          <p className="context-note">{hint(entry)}</p>
        </div>
        <div className="header-actions">
          {canOpen && (
            <>
              <AppLink url={p!.url!} primary />
              <CopyButton value={p!.url!} label="Copy URL" />
            </>
          )}
          {actions.map((action) => (
            <Button
              key={action.label}
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
          onValueChange={(value) => setTab(value as Tab)}
        >
          <TabsList
            variant="line"
            className="preview-tab-list"
            aria-label="Preview diagnostics"
          >
            <TabsTrigger value="activity" id="tab-activity">
              Activity
            </TabsTrigger>
            {selected && (
              <TabsTrigger value="logs" id="tab-logs">
                Logs
              </TabsTrigger>
            )}
            {selected && !owner.legacy && (
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
              {tab === view && selected && (
                <Diagnostics
                  entry={entry}
                  tab={view}
                  selected={selected}
                  retained={retained}
                  selectAttempt={(id) => {
                    setAttemptId(id);
                    setSource("");
                  }}
                  source={source}
                  setSource={setSource}
                  query={query}
                  setQuery={setQuery}
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
