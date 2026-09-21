import { useEffect, useRef, useState } from "react";
import { RefreshCwIcon, WrapTextIcon } from "lucide-react";
import type {
  AttemptSummary,
  LogResult,
  PreviewDescription,
} from "../../src/contracts";
import type { Mutate } from "./lib/api";
import type { Entry } from "./lib/model";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./components/ui/select";
import { Toggle } from "./components/ui/toggle";
import { Spinner } from "./components/ui/spinner";
import { ScrollArea } from "./components/ui/scroll-area";
import {
  Loading,
  Notice,
  Path,
  SearchField,
  Section,
} from "./components/shared";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "./components/ui/table";

type Props = {
  entry: Entry;
  tab: "logs" | "configuration";
  selected: AttemptSummary;
  retained: AttemptSummary[];
  selectAttempt: (id: string) => void;
  source: string;
  setSource: (source: string) => void;
  query: string;
  setQuery: (query: string) => void;
  wrapLogs: boolean;
  setWrapLogs: (wrap: boolean) => void;
  mutate: Mutate;
  acting: boolean;
};
type Result = {
  key: string;
  logs?: LogResult;
  description?: PreviewDescription;
  error?: string;
};

export function Diagnostics({
  entry,
  tab,
  selected,
  retained,
  selectAttempt,
  source,
  setSource,
  query,
  setQuery,
  wrapLogs,
  setWrapLogs,
  mutate,
  acting,
}: Props) {
  const [result, setResult] = useState<Result>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const key = [entry.owner.id, entry.name, selected.id, tab, source].join("/");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void call<LogResult | PreviewDescription>(
      {
        action: tab === "logs" ? "logs" : "describe",
        owner: entry.owner.id,
        name: entry.name,
        attemptId: selected.id,
        ...(tab === "logs" && source ? { source } : {}),
      },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setResult(
            tab === "logs"
              ? { key, logs: value as LogResult }
              : { key, description: value as PreviewDescription },
          );
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({ key, error: errorMessage(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [entry.owner.id, entry.name, selected.id, tab, source, key, revision]);
  const current = result?.key === key ? result : undefined;
  const logs = current?.logs;
  const description = current?.description;
  const matches =
    logs && query
      ? logs.text
          .split("\n")
          .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
      : [];
  const output = logs
    ? query
      ? matches.join("\n") || "No matching lines in captured output."
      : logs.text || "No output captured."
    : "";
  function search(value: string) {
    setQuery(value);
    body.current?.scrollTo(0, 0);
  }
  return (
    <>
      <div
        className={
          tab === "logs"
            ? "diagnostic-toolbar logs-toolbar"
            : "diagnostic-toolbar"
        }
      >
        {tab === "logs" && (
          <SearchField
            value={query}
            onChange={search}
            label="Search logs"
            disabled={!logs}
          />
        )}
        <Select value={selected.id} onValueChange={selectAttempt}>
          <SelectTrigger aria-label="Diagnostic attempt">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {retained.map((attempt) => (
                <SelectItem value={attempt.id} key={attempt.id}>
                  {attempt.id === entry.preview?.active?.id
                    ? "Serving"
                    : attempt.id === entry.preview?.candidate?.id
                      ? "Starting"
                      : "Latest"}{" "}
                  · {attempt.id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {tab === "logs" && (
          <Select
            value={source || "*"}
            onValueChange={(value) => setSource(value === "*" ? "" : value)}
          >
            <SelectTrigger aria-label="Log source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="*">All output</SelectItem>
                {(selected.type === "environment"
                  ? Object.keys(selected.services ?? {})
                  : [entry.preview!.name]
                ).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          className="refresh-details"
          aria-label={loading ? "Refreshing…" : "Refresh"}
          disabled={loading || acting}
          onClick={() => setRevision((value) => value + 1)}
        >
          {loading ? <Spinner /> : <RefreshCwIcon className="refresh-icon" />}
          <span className="refresh-label">
            {loading ? "Refreshing…" : "Refresh"}
          </span>
        </Button>
        {tab === "logs" && (
          <div className="log-options">
            <p role="status" className="log-note">
              {logs
                ? query
                  ? `${matches.length} matching ${matches.length === 1 ? "line" : "lines"}`
                  : "Captured output"
                : loading
                  ? "Loading output…"
                  : "Output unavailable"}
              {logs?.truncated ? " · Earlier output omitted" : ""}
            </p>
            <Toggle size="sm" pressed={wrapLogs} onPressedChange={setWrapLogs}>
              <WrapTextIcon data-icon="inline-start" />
              Wrap lines
            </Toggle>
          </div>
        )}
      </div>
      <div
        className={
          tab === "logs" && logs
            ? "scroll-panel log-panel"
            : "scroll-panel diagnostic-body"
        }
        ref={body}
        tabIndex={0}
        role="region"
        aria-label={tab === "logs" ? "Log output" : "Configuration details"}
        aria-busy={loading}
      >
        {current?.error ? (
          <Notice title="Details unavailable" error>
            {current.error}
          </Notice>
        ) : !current ? (
          <Loading />
        ) : tab === "logs" ? (
          <pre className="logs" data-wrap={wrapLogs}>
            {output}
          </pre>
        ) : (
          description && (
            <Configuration entry={entry} description={description} />
          )
        )}
      </div>
      {tab === "configuration" && description && (
        <div className="save-row">
          <p>Existing files are never overwritten.</p>
          <Button
            variant="outline"
            disabled={acting || loading}
            onClick={() =>
              void mutate<{ file: string; externalSources: string[] }>(
                {
                  action: "saveConfiguration",
                  owner: entry.owner.id,
                  name: entry.name,
                  attemptId: selected.id,
                },
                (result) =>
                  `Saved ${result.file}. The running preview is unchanged.` +
                  (result.externalSources.length
                    ? " Sources outside this project keep absolute paths: " +
                      result.externalSources.join(", ")
                    : ""),
              )
            }
          >
            Save as preview.yaml
          </Button>
        </div>
      )}
    </>
  );
}

const bindingLabels: Record<string, string> = {
  secret: "Secret",
  fromEnv: "Owner input",
  service: "Service URL",
  publicUrl: "Public URL",
  browserUrl: "Browser URL",
};

function Configuration({
  entry,
  description,
}: {
  entry: Entry;
  description: PreviewDescription;
}) {
  const keys = new Set([
    ...description.envKeys,
    ...(description.secrets ?? []).flatMap((secret) =>
      secret.bindings.map(
        (binding) =>
          (binding.service ? binding.service + "." : "") + binding.key,
      ),
    ),
  ]);
  const spec = description.spec;
  return (
    <>
      <Section title="Environment variables">
        <ScrollArea
          className="data-table env-table"
          type="always"
          aria-label="Environment variables"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...keys].map((key) => {
                const secret = description.secrets?.find((secret) =>
                  secret.bindings.some(
                    (binding) =>
                      (binding.service ? binding.service + "." : "") +
                        binding.key ===
                      key,
                  ),
                );
                const [service, envKey] = key.split(".");
                const binding =
                  spec.type === "environment"
                    ? spec.services[service]?.bindings?.[envKey]
                    : undefined;
                return (
                  <TableRow key={key}>
                    <TableCell>
                      <code>{key}</code>
                    </TableCell>
                    <TableCell>
                      {secret
                        ? "Secret"
                        : binding
                          ? bindingLabels[Object.keys(binding)[0]]
                          : "Literal"}
                    </TableCell>
                    <TableCell>
                      {secret ? (
                        <>
                          <code>{secret.id}</code>
                          <p className="text-muted-foreground">
                            {secret.selected
                              ? "Approved for this owner"
                              : "Approval required"}
                          </p>
                        </>
                      ) : binding ? (
                        <code>{String(Object.values(binding)[0])}</code>
                      ) : (
                        <span className="text-muted-foreground">
                          Not included
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!keys.size && (
                <TableRow>
                  <TableCell colSpan={3}>
                    No environment variables declared.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </Section>
      {entry.owner.configuration && (
        <p className="text-muted-foreground">
          {entry.owner.configuration.file.split("/").at(-1)} exists. This view
          shows the selected runtime attempt.
        </p>
      )}
      <Section title="Service definitions">
        {spec.type === "environment" && (
          <div className="definitions">
            {Object.entries(spec.services).map(([name, service]) => (
              <div key={name} className="definition-row">
                <div className="flex items-center gap-3">
                  <strong>{name}</strong>
                  <span className="text-muted-foreground">{service.type}</span>
                </div>
                {service.command && (
                  <pre>{JSON.stringify(service.command)}</pre>
                )}
                {!!service.dependsOn?.length && (
                  <p className="text-muted-foreground">
                    After: {service.dependsOn.join(", ")}
                  </p>
                )}
                {service.run && (
                  <p className="text-muted-foreground">
                    {service.run === "once"
                      ? "Once per retained environment; explicit rerun required after failure."
                      : "Runs on every start and replacement."}
                  </p>
                )}
                {(service.cwd || service.directory) && (
                  <Path value={service.cwd ?? service.directory!} />
                )}
              </div>
            ))}
          </div>
        )}
        <details>
          <summary>Full requested configuration</summary>
          <pre className="configuration">{JSON.stringify(spec, null, 2)}</pre>
        </details>
      </Section>
    </>
  );
}
