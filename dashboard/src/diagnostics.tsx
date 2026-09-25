import { useEffect, useRef, useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
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
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup,
  DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
import { searchLogs } from "./lib/log-search";
import { Spinner } from "./components/ui/spinner";
import { ScrollArea } from "./components/ui/scroll-area";
import {
  Disclosure,
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
  showContext: boolean;
  setShowContext: (context: boolean) => void;
  mutate: Mutate;
  acting: boolean;
  revision: number;
  clearAfter?: number;
  setClearAfter: (after: number | undefined) => void;
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
  showContext,
  setShowContext,
  mutate,
  acting,
  revision,
  clearAfter,
  setClearAfter,
}: Props) {
  const [result, setResult] = useState<Result>();
  const [loading, setLoading] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const key = [
    entry.owner.id,
    entry.name,
    selected.id,
    tab,
    source,
    clearAfter,
  ].join("/");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void call<LogResult | PreviewDescription>(
      {
        action: tab === "logs" ? "logs" : "describe",
        owner: entry.owner.id,
        name: entry.name,
        attemptId: selected.id,
        ...(tab === "logs"
          ? { source: source || undefined, after: clearAfter }
          : {}),
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
  }, [
    entry.owner.id,
    entry.name,
    selected.id,
    tab,
    source,
    key,
    revision,
    clearAfter,
  ]);
  const current = result?.key === key ? result : undefined;
  const logs = current?.logs;
  const description = current?.description;
  const matches = logs && query ? searchLogs(logs.text, query, showContext) : undefined;
  const output = logs
    ? query
      ? matches?.text || "No matching lines in captured output."
      : logs.text ||
        (clearAfter === undefined
          ? "No output captured."
          : "No new output. Refresh to check again.")
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
          <SelectTrigger aria-label="Diagnostic attempt" className="attempt-select">
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
        {tab === "configuration" && loading && (
          <Spinner aria-label="Loading configuration" />
        )}
        {tab === "logs" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Log options">
                {loading ? <Spinner aria-label="Refreshing output" /> : <MoreHorizontalIcon />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem checked={wrapLogs} onCheckedChange={setWrapLogs}>
                  Wrap lines
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showContext} onCheckedChange={setShowContext} disabled={!query}>
                  Include surrounding lines
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={loading || !logs?.text}
                  onSelect={() => {
                    setClearAfter(logs!.cursor);
                    body.current?.scrollTo(0, 0);
                  }}
                >
                  Clear view
                </DropdownMenuItem>
                {clearAfter !== undefined && (
                  <DropdownMenuItem onSelect={() => setClearAfter(undefined)}>
                    Show earlier logs
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {tab === "logs" && (query || clearAfter !== undefined || logs?.truncated) && (
          <div className="log-options">
            <p role="status" className="log-note">
              {logs
                ? query
                  ? `${matches!.count} matching ${matches!.count === 1 ? "line" : "lines"}${showContext ? " · With context" : ""}`
                  : ""
                : loading
                  ? "Loading output…"
                  : "Output unavailable"}
              {logs && clearAfter !== undefined ? `${query ? " · " : ""}Earlier output hidden` : ""}
              {logs?.truncated ? `${query || clearAfter !== undefined ? " · " : ""}Earlier output omitted` : ""}
            </p>
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
            <Configuration description={description} />
          )
        )}
      </div>
      {tab === "configuration" && description && (
        <div className="save-row">
          {entry.owner.configuration?.error ? (
            <p>Configuration needs attention. See Activity.</p>
          ) : entry.owner.configuration ? (
            <p>
              <code>{entry.owner.configuration.file.split("/").at(-1)}</code> already exists.
              {" "}Showing this attempt’s configuration.
            </p>
          ) : (
            <>
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
            </>
          )}
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
  description,
}: {
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
        {keys.size ? (
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
              </TableBody>
            </Table>
          </ScrollArea>
        ) : (
          <p className="text-muted-foreground">No variables declared.</p>
        )}
      </Section>
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
        <Disclosure title="Requested configuration">
          <pre className="configuration">{JSON.stringify(spec, null, 2)}</pre>
        </Disclosure>
      </Section>
    </>
  );
}
