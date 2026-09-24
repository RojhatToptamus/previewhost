import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./components/ui/collapsible";
import type { AttemptSummary, ServiceStatus } from "../../src/contracts";
import type { Mutate } from "./lib/api";
import {
  deletionNeedsRetry,
  needsCleanup,
  pending,
  requests,
  type Entry,
} from "./lib/model";
import { Button } from "./components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "./components/ui/table";
import { ConfirmAction } from "./components/confirm-action";
import { AppLink, Notice, Path, Section, Status } from "./components/shared";

type Props = {
  entry: Entry;
  mutate: Mutate;
  acting: boolean;
  openLogs: (attempt: AttemptSummary, source?: string) => void;
};
const setupLabels = {
  pending: "Awaiting approval or entry",
  saving: "Saving",
  complete: "Complete",
  partial: "Incomplete",
  canceled: "Canceled",
  expired: "Expired",
};
const capitalize = (value: string) => value[0].toUpperCase() + value.slice(1);
const types: Record<string, string> = {
  command: "HTTP",
  static: "Static",
  attach: "Attached HTTP",
  postgres: "PostgreSQL",
  redis: "Redis",
  "external-postgres": "PostgreSQL",
  "external-redis": "Redis",
};
const tone = (value: string) =>
  value === "failed"
    ? "error"
    : ["ready", "succeeded"].includes(value)
      ? "ready"
      : "muted";

export function Activity(props: Props) {
  const { entry, mutate, acting, openLogs } = props;
  const { owner, preview: p } = entry;
  const latest = p?.candidate ?? p?.latest;
  const setupRequests = requests(entry);
  const openRequests = pending(entry);
  const currentRequests = openRequests.length
    ? openRequests
    : setupRequests.slice(-1);
  return (
    <>
      {deletionNeedsRetry(p) ? (
        <Notice title="Data deletion incomplete" error>
          Managed data was deleted, but its database credential could not be
          removed. Resolve the keystore error, then review data deletion again.
        </Notice>
      ) : needsCleanup(p) ? (
        <Notice title="Cleanup needs attention" error>
          Some owned resources could not be confirmed stopped. Inspect the
          details before retrying cleanup.
        </Notice>
      ) : openRequests.length ? (
        <Notice title="Private setup requested">
          Approve access or enter missing values in the private form. Cancel
          there.
        </Notice>
      ) : null}
      {p && (
        <>
          {p.active && latest && p.active.id !== latest.id ? (
            <div className="attempt-split">
              {(
                [
                  ["Serving", p.active],
                  ["Latest update", latest],
                ] as const
              ).map(([label, attempt]) => (
                <div key={label}>
                  <p className="text-muted-foreground">{label}</p>
                  <code title={attempt.id}>{attempt.id.slice(0, 8)}</code>
                  <Status tone={tone(attempt.state)}>
                    {capitalize(attempt.state)}
                  </Status>
                  <AttemptTime attempt={attempt} />
                  <AttemptFailure attempt={attempt} openLogs={openLogs} />
                </div>
              ))}
            </div>
          ) : (
            (p.active ?? latest) && (
              <div className="attempt-line">
                <span className="section-label">
                  {p.active ? "Serving" : "Latest attempt"}
                </span>
                <code title={(p.active ?? latest)!.id}>
                  {(p.active ?? latest)!.id.slice(0, 8)}
                </code>
                <AttemptTime attempt={(p.active ?? latest)!} />
              </div>
            )
          )}
          {!(p.active && latest && p.active.id !== latest.id) && latest && (
            <AttemptFailure attempt={latest} openLogs={openLogs} />
          )}
          <Services {...props} />
          <Jobs {...props} />
        </>
      )}
      {owner.configuration?.error && (
        <Notice title="Configuration needs attention" error>
          {owner.configuration.error.message}
          {p?.active ? " The running app is unchanged." : ""}
        </Notice>
      )}
      {(p?.cleanup?.length || p?.data?.cleanup) && (
        <Notice title="Cleanup needs attention" error>
          <p>
            {deletionNeedsRetry(p)
              ? "Database credential removal is incomplete."
              : "Keep these source directories until cleanup succeeds."}
          </p>
          {p.cleanup?.map((item) => (
            <div key={item.attemptId}>
              <p>{item.error.message}</p>
              {item.sources.map((source) => (
                <Path key={source} value={source} />
              ))}
            </div>
          ))}
          {p.data?.cleanup && <p>{p.data.cleanup.message}</p>}
        </Notice>
      )}
      {!!setupRequests.length && (
        <Section title="Private setup">
          {currentRequests.map((request) => (
            <div key={request.id} className="request">
              <strong>
                {!openRequests.length && "Latest request: "}
                {setupLabels[request.state]}
              </strong>
              {["pending", "saving"].includes(request.state) && (
                <time>
                  Expires {new Date(request.expiresAt).toLocaleTimeString()}
                </time>
              )}
              {request.state === "pending" && openRequests.length > 1 && (
                <Button
                  variant="outline"
                  disabled={acting}
                  onClick={() =>
                    void mutate(
                      {
                        action: "secretsOpen",
                        owner: owner.id,
                        id: request.id,
                      },
                      "Private form requested in your system browser.",
                    )
                  }
                >
                  Open request {request.id.slice(0, 8)}
                </Button>
              )}
              {request.browser === "failed" && request.state === "pending" && (
                <p className="error">
                  The browser did not open. Try opening the private form again.
                </p>
              )}
              {request.state === "canceled" && (
                <p>
                  This request was canceled. Ask for new setup only when you
                  want to continue.
                </p>
              )}
              {request.state === "expired" && (
                <p>
                  If setup is still needed, ask your agent for a new request.
                </p>
              )}
              {request.state === "partial" && (
                <p>
                  Ask your agent to check this request’s result before continuing.
                </p>
              )}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

function attemptScope(
  preview: NonNullable<Entry["preview"]>,
  attempt: AttemptSummary,
) {
  if (attempt.id === preview.active?.id) return "serving";
  return preview.active ? "latest update" : "latest attempt";
}

function AttemptTime({ attempt }: { attempt: AttemptSummary }) {
  const started = new Date(attempt.startedAt);
  return (
    <time className="attempt-time" dateTime={attempt.startedAt} title={started.toLocaleString()}>
      {started.toLocaleTimeString()}
    </time>
  );
}

function AttemptFailure({
  attempt,
  openLogs,
}: {
  attempt: AttemptSummary;
  openLogs: Props["openLogs"];
}) {
  if (attempt.state !== "failed") return null;
  const failed = Object.entries(attempt.services ?? {}).filter(
    ([, service]) => service.state === "failed",
  );
  return (
    <div className="attempt-failure">
      {failed.length ? (
        failed.map(([name, service]) => (
          <div key={name}>
            <div className="flex items-center justify-between gap-3">
              <strong>{name}</strong>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openLogs(attempt, name)}
              >
                Logs
              </Button>
            </div>
            {service.type !== "job" && service.error && (
              <p className="text-muted-foreground">{service.error.message}</p>
            )}
          </div>
        ))
      ) : (
        <div>
          <p>
            {attempt.error?.message ??
              "Startup failed. Review this attempt’s output."}
          </p>
          <Button variant="ghost" size="sm" onClick={() => openLogs(attempt)}>
            Logs
          </Button>
        </div>
      )}
    </div>
  );
}

function Services({ entry, openLogs }: Pick<Props, "entry" | "openLogs">) {
  const p = entry.preview!;
  const attempt = p.active ?? p.candidate ?? p.latest;
  if (!attempt && !p.data) return null;
  const managed = new Set(
    p.data?.resources.map((resource) => resource.name) ?? [],
  );
  const dataLabel =
    p.data?.cleanup?.operation === "remove-credential"
      ? "Data deleted"
      : p.data?.cleanup
        ? "Check data"
        : "Data retained";
  const services = Object.entries(attempt?.services ?? {})
    .filter(([, service]) => service.type !== "job")
    .sort(([a], [b]) => Number(managed.has(a)) - Number(managed.has(b)));
  if (!services.length && attempt && attempt.type !== "environment")
    services.push([
      p.name,
      {
        type: attempt.type,
        state:
          attempt.state === "ready"
            ? "ready"
            : attempt.state === "starting"
              ? "starting"
              : attempt.state === "failed"
                ? "failed"
                : "stopped",
      } as ServiceStatus,
    ]);
  return (
    <Section
      title={"Services" + (attempt ? " · " + attemptScope(p, attempt) : "")}
    >
      <div className="data-table service-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Address / data</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map(([name, service]) => {
              const url =
                attempt?.id === p.active?.id ? service.browserUrl : undefined;
              return (
                <TableRow key={name}>
                  <TableCell>
                    <strong>{name}</strong>
                    {service.error && (
                      <p className="error">{service.error.message}</p>
                    )}
                    {!!service.waitingFor?.length && (
                      <p className="text-muted-foreground">
                        Waiting for <code>{service.waitingFor.join(", ")}</code>
                      </p>
                    )}
                  </TableCell>
                  <TableCell>{types[service.type]}</TableCell>
                  <TableCell>
                    <Status tone={tone(service.state)}>
                      {capitalize(service.state)}
                    </Status>
                  </TableCell>
                  <TableCell>
                    {managed.has(name) ? (
                      dataLabel
                    ) : url ? (
                      <div className="service-address">
                        <AppLink url={url} variant="link">
                          {url.replace(/^http:\/\//, "")}
                        </AppLink>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="row-actions">
                      {service.type === "command" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openLogs(attempt!, name)}
                        >
                          Logs
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {p.data?.resources
              .filter(
                (resource) =>
                  !services.some(([name]) => name === resource.name),
              )
              .map((resource) => (
                <TableRow key={resource.name}>
                  <TableCell>{resource.name}</TableCell>
                  <TableCell>{types[resource.type]}</TableCell>
                  <TableCell>
                    {p.data?.cleanup ? "Needs cleanup" : "Retained"}
                  </TableCell>
                  <TableCell>{dataLabel}</TableCell>
                  <TableCell />
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {!!attempt?.sources?.length && (
        <Collapsible className="source-disclosure">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="disclosure-trigger">
              <ChevronRightIcon data-icon="inline-start" />Source folders
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="source-folders">
            {attempt.sources.map((source) => (
              <Path key={source} value={source} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </Section>
  );
}

function Jobs({ entry, mutate, acting, openLogs }: Props) {
  const p = entry.preview!;
  const attempt = p.candidate ?? p.latest ?? p.active;
  const jobs = Object.entries(attempt?.services ?? {}).filter(
    ([, service]) => service.type === "job",
  );
  if (!jobs.length || !attempt) return null;
  return (
    <Section title={"Setup jobs · " + attemptScope(p, attempt)}>
      <div className="data-table jobs-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map(([name, job]) => (
              <TableRow key={name}>
                <TableCell>
                  <strong>{name}</strong>
                  {!!job.waitingFor?.length && (
                    <p className="text-muted-foreground">
                      Waiting for <code>{job.waitingFor.join(", ")}</code>
                    </p>
                  )}
                  {job.error ? (
                    <p className="text-muted-foreground">{job.error.message}</p>
                  ) : (
                    job.state === "skipped" && (
                      <p className="text-muted-foreground">
                        Already applied to retained data.
                      </p>
                    )
                  )}
                </TableCell>
                <TableCell>
                  <Status tone={tone(job.state)}>
                    {job.state === "starting"
                      ? "Running"
                      : capitalize(job.state)}
                  </Status>
                </TableCell>
                <TableCell>
                  <div className="row-actions">
                    {!p.active &&
                      !p.busy &&
                      !p.candidate &&
                      !needsCleanup(p) && (
                        <ConfirmAction
                          label="Run again"
                          accessibleLabel={"Run " + name + " again"}
                          disabled={acting}
                          mutate={mutate}
                          request={{
                            title: `Run ${name} again?`,
                            description:
                              "Starts the preview and its dependencies. Previous writes remain; running this job again may duplicate data.",
                            body: {
                              action: "rerunJob",
                              owner: entry.owner.id,
                              name: p.name,
                              attemptId: attempt.id,
                              job: name,
                            },
                            message: "Job rerun and startup requested.",
                            confirmLabel: "Run and start preview",
                          }}
                        />
                      )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openLogs(attempt, name)}
                    >
                      Logs
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {p.active && jobs.some(([, job]) => job.state === "failed") && (
        <p className="job-hint">Stop the preview to rerun a job.</p>
      )}
    </Section>
  );
}
