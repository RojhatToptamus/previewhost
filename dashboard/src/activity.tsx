import type { AttemptSummary, ServiceStatus } from "../../src/contracts";
import type { Mutate } from "./lib/api";
import {
  attempts,
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
  const failedJob = Object.values(latest?.services ?? {}).some(
    (service) => service.type === "job" && service.state === "failed",
  );
  return (
    <>
      {deletionNeedsRetry(p) ? (
        <Notice title="Data deletion incomplete" error>
          Managed data was deleted, but its database credential could not be
          removed. Resolve the Keychain error, then retry Delete data or Reset
          data.
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
      ) : !p?.candidate && latest?.state === "failed" && !failedJob ? (
        <Notice title={p?.active ? "Update failed" : "Startup failed"} error>
          <p>
            {latest.error?.message ?? "Review the latest attempt for details."}
          </p>
          <Button variant="outline" onClick={() => openLogs(latest)}>
            View error log
          </Button>
        </Notice>
      ) : !p?.candidate && latest?.state === "canceled" ? (
        <Notice title={p?.active ? "Update canceled" : "Startup canceled"}>
          Nothing was started again automatically. Ask your agent to continue
          only when you are ready.
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
              </div>
            )
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
      <Section title="Recent attempts">
        {attempts(p).map((attempt) => (
          <div className="activity-row" key={attempt.id}>
            <time>{new Date(attempt.startedAt).toLocaleTimeString()}</time>
            <div>
              <strong>
                {attempt.id === p?.active?.id
                  ? "Serving now"
                  : "Attempt " + attempt.state}
              </strong>
              <code className="attempt-id">{attempt.id}</code>
            </div>
          </div>
        ))}
        {!attempts(p).length && (
          <p className="text-muted-foreground">
            No retained attempts. Start through your agent or CLI.
          </p>
        )}
      </Section>
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
    <Section title="Services">
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
        <details>
          <summary>Source folders</summary>
          <div className="source-folders">
            {attempt.sources.map((source) => (
              <Path key={source} value={source} />
            ))}
          </div>
        </details>
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
    <Section
      title={
        p.active && p.active.id !== attempt.id
          ? "Setup jobs · latest update"
          : "Setup jobs"
      }
    >
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
