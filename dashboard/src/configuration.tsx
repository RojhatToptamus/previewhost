import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ConfigurationBindingChange,
  EnvironmentValue,
  PreviewDescription,
} from "../../src/contracts";
import type {
  ConfigurationView,
  PreviewReview,
} from "../../src/dashboard-workflows";
import { bindingLabels as labels, type Entry } from "./lib/model";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "./components/ui/table";
import { ScrollArea } from "./components/ui/scroll-area";
import { Spinner } from "./components/ui/spinner";
import { Disclosure, Loading, Notice, Path } from "./components/shared";
import {
  PreviewReviewDialog,
  mutationError,
  type LaunchResult,
} from "./preview-workflow";

import { SecretReferencePicker } from "./secret-reference-picker";

type Binding = ConfigurationView["bindings"][number];
const bindingId = (binding: { service?: string; key: string }) =>
  `${binding.service ?? ""}/${binding.key}`;
const bindingType = (value: Binding["value"] | string) =>
  value === null || typeof value === "string"
    ? "literal"
    : Object.keys(value)[0];

export function ConfigurationPanel({
  entry,
  attemptId,
  revision,
  snapshot,
  onStarted,
}: {
  entry: Entry;
  attemptId?: string;
  revision: number;
  snapshot?: ReactNode;
  onStarted(result: LaunchResult): void;
}) {
  const [mode, setMode] = useState("current");
  const [configuration, setConfiguration] = useState<ConfigurationView>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [service, setService] = useState("");
  const [changes, setChanges] = useState<ConfigurationBindingChange[]>([]);
  const [editing, setEditing] = useState<{ row?: Binding; service?: string }>();
  const [review, setReview] = useState<PreviewReview>();
  // A closed review can still be resumed; retire it once before changing its local edits.
  const retainedReview = useRef<string | undefined>(undefined);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const dirty = changes.length > 0;
  const failedAttempt =
    entry.preview?.latest?.state === "failed" && entry.preview.latest.id !== attemptId
      ? entry.preview.latest
      : undefined;
  const editingAttemptId = mode === "failed" ? failedAttempt?.id ?? attemptId : attemptId;
  const recipeFile =
    mode === "recipe" ? entry.owner.configuration?.file : undefined;
  useEffect(() => {
    if (dirty || busy || editing || review || mode === "snapshot" || entry.owner.error) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setConfiguration(undefined);
    void call<ConfigurationView>(
      {
        action: "configurationOpen",
        owner: entry.owner.id,
        name: entry.name,
        attemptId: editingAttemptId,
        file: recipeFile,
      },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setConfiguration(result);
      })
      .catch((problem) => {
        if (!controller.signal.aborted) setError(errorMessage(problem));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Edits remain local until Save or Apply. Polling must not replace the form beneath them.
  }, [
    entry.owner.id,
    entry.name,
    editingAttemptId,
    revision,
    refresh,
    mode,
    recipeFile,
    entry.owner.error,
  ]);
  const spec = configuration?.description.spec;
  const services =
    spec?.type === "environment"
      ? Object.entries(spec.services)
          .filter(
            ([, definition]) =>
              definition.type === "command" || definition.type === "job",
          )
          .map(([name]) => name)
      : spec?.type === "command"
        ? [""]
        : [];
  const selectedService = services.includes(service) ? service : services[0];
  const rows = new Map(
    (configuration?.bindings ?? []).map((row) => [bindingId(row), row]),
  );
  for (const change of changes) {
    if (change.value !== null)
      rows.set(bindingId(change), {
        service: change.service,
        key: change.key,
        value: typeof change.value === "string" ? null : change.value,
      });
  }
  const visible = [...rows.values()]
    .filter((row) => (row.service ?? "") === selectedService)
    .sort((a, b) => a.key.localeCompare(b.key));
  async function revise(update: () => void, reload = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (retainedReview.current) {
        await call({ action: "configurationDiscard", id: retainedReview.current });
        retainedReview.current = undefined;
      }
      update();
      if (reload) setRefresh(value => value + 1);
    } catch (problem) {
      const message = mutationError(problem);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  }
  async function stage(change: ConfigurationBindingChange) {
    const isNew = !configuration?.bindings.some(
      (row) => bindingId(row) === bindingId(change),
    );
    return revise(() => {
      setChanges((previous) => [
        ...previous.filter((item) => bindingId(item) !== bindingId(change)),
        ...(isNew && change.value === null ? [] : [change]),
      ]);
      setMessage("");
      setEditing(undefined);
    });
  }
  async function save() {
    if (!configuration || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await call<ConfigurationView>({
        action: "configurationSave",
        id: configuration.id,
        changes,
      });
      setConfiguration(result);
      retainedReview.current = undefined;
      setChanges([]);
      setMessage(
        "File saved. Apply it when you are ready; the running preview is unchanged.",
      );
    } catch (problem) {
      setError(mutationError(problem));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (!configuration || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await call<PreviewReview>({
        action: "configurationReview",
        id: configuration.id,
        changes,
      });
      retainedReview.current = result.id;
      setConfiguration(previous => previous && { ...previous, id: result.id });
      setReview(result);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="diagnostic-toolbar configuration-toolbar">
        <Select
          value={mode === "failed" && !failedAttempt ? "current" : mode}
          onValueChange={setMode}
          disabled={busy || dirty}
        >
          <SelectTrigger aria-label="Configuration source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="current">Current configuration</SelectItem>
              {failedAttempt && (
                <SelectItem value="failed">Failed update configuration</SelectItem>
              )}
              {entry.owner.configuration?.file &&
                (mode === "recipe" ||
                  entry.owner.configuration.file !== configuration?.file) && (
                  <SelectItem value="recipe">
                    Project configuration file
                  </SelectItem>
                )}
              {snapshot && (
                <SelectItem value="snapshot">Recorded attempt</SelectItem>
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
        {mode !== "snapshot" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || dirty || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Reload
          </Button>
        )}
      </div>
      {mode === "snapshot" ? (
        snapshot
      ) : (
        <>
          <div
            className="diagnostic-body scroll-panel configuration-body"
            aria-busy={loading || busy}
          >
            {loading && !configuration ? (
              <Loading>Reading configuration…</Loading>
            ) : (
              configuration && (
                <>
                  <div className="configuration-source">
                    <strong>
                      {configuration.file
                        ? "Configuration file"
                        : "Retained preview configuration"}
                    </strong>
                    {configuration.file && <Path value={configuration.file} />}
                    {entry.name &&
                      configuration.description.spec.name !== entry.name && (
                        <p>
                          This file defines{" "}
                          <strong>{configuration.description.spec.name}</strong>
                          .
                        </p>
                      )}
                    <p className="text-muted-foreground">
                      {configuration.file
                        ? "Save changes, then Apply. Restart uses the last attempt."
                        : "Apply edits directly to this preview. Save as preview.yaml is optional and creates a configuration file for future starts."}
                    </p>
                  </div>
                  <div className="configuration-section-heading">
                    <h2>Environment variables</h2>
                    {services.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || loading}
                        onClick={() =>
                          setEditing({ service: selectedService || undefined })
                        }
                      >
                        Add variable
                      </Button>
                    )}
                  </div>
                  {spec?.type === "environment" && services.length > 0 && (
                    <Field className="configuration-service">
                      <FieldLabel htmlFor="configuration-service">
                        Service or job
                      </FieldLabel>
                      <Select
                        value={selectedService}
                        onValueChange={setService}
                        disabled={busy}
                      >
                        <SelectTrigger id="configuration-service">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {services.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name} · {spec.services[name].type}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                  {visible.length ? (
                    <ScrollArea
                      className="data-table env-table editable-env-table [&_[data-slot=scroll-area-viewport]]:max-h-[min(320px,45dvh)]"
                      style={{ height: "auto" }}
                      type="always"
                      aria-label="Environment variables"
                    >
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Reference</TableHead>
                            <TableHead className="text-right">
                              Actions
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visible.map((row) => {
                            const change = changes.find(
                              (change) => bindingId(change) === bindingId(row),
                            );
                            const removed = change?.value === null;
                            return (
                              <TableRow key={bindingId(row)}>
                                <TableCell>
                                  <code>{row.key}</code>
                                  {change && (
                                    <span className="env-change">
                                      {removed ? "Removed" : "Changed"}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {labels[bindingType(row.value)]}
                                </TableCell>
                                <TableCell>
                                  {row.value ? (
                                    <code>{Object.values(row.value)[0]}</code>
                                  ) : (
                                    <span className="text-muted-foreground">
                                      Value not shown
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="row-actions">
                                    {removed ? (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy}
                                        aria-label={`Undo removal of ${row.key}`}
                                        onClick={() =>
                                          void revise(() => setChanges((previous) =>
                                            previous.filter(
                                              (item) =>
                                                bindingId(item) !==
                                                bindingId(row),
                                            ),
                                          ))
                                        }
                                      >
                                        Undo
                                      </Button>
                                    ) : (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          disabled={busy || loading}
                                          aria-label={`Edit ${row.key}`}
                                          onClick={() =>
                                            setEditing({
                                              row,
                                              service: row.service,
                                            })
                                          }
                                        >
                                          Edit
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          disabled={busy || loading}
                                          aria-label={`Remove ${row.key}`}
                                          onClick={() =>
                                            stage({
                                              service: row.service,
                                              key: row.key,
                                              value: null,
                                            })
                                          }
                                        >
                                          Remove
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  ) : (
                    <p className="text-muted-foreground">
                      {services.length
                        ? "No variables declared for this service."
                        : "This preview has no command or job environment variables."}
                    </p>
                  )}
                  <p className="configuration-help">
                    Secret bindings use a reference name. Change a stored value
                    in Secret Manager; removing a binding keeps its stored
                    value.
                  </p>
                  <Disclosure title="Service definitions">
                    <pre className="configuration">
                      {JSON.stringify(configuration.description.spec, null, 2)}
                    </pre>
                  </Disclosure>
                </>
              )
            )}
            {error && (
              <Notice title="Configuration needs attention" error>
                <p>{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revise(() => setChanges([]), true)}
                >
                  {dirty ? "Discard changes & reload" : "Reload configuration"}
                </Button>
              </Notice>
            )}
            {message && (
              <p role="status" className="configuration-feedback">
                {message}
              </p>
            )}
          </div>
          {configuration && (
            <div className="save-row configuration-save-row">
              <p>
                {dirty
                  ? `${changes.length} unsaved ${changes.length === 1 ? "change" : "changes"}.`
                  : ""}
              </p>
              {dirty && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void revise(() => setChanges([]), true)}
                >
                  Discard changes
                </Button>
              )}
              <Button
                variant={configuration.file && dirty ? "default" : "outline"}
                disabled={
                  busy || loading || Boolean(configuration.file && !dirty)
                }
                onClick={() => void save()}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {configuration.file ? "Save file" : "Save as preview.yaml"}
              </Button>
              <Button
                ref={reviewTrigger}
                variant={configuration.file && dirty ? "outline" : "default"}
                disabled={
                  busy || loading || Boolean(configuration.file && dirty)
                }
                onClick={() => void prepare()}
              >
                Review and apply
              </Button>
            </div>
          )}
        </>
      )}
      {editing && configuration && (
        <BindingEditor
          key={bindingId({
            service: editing.service,
            key: editing.row?.key ?? "",
          })}
          row={editing.row}
          service={editing.service}
          spec={configuration.description.spec}
          existingKeys={visible.map((row) => row.key)}
          onClose={() => setEditing(undefined)}
          onSave={stage}
          busy={busy}
          unavailable={entry.owner.error?.message}
        />
      )}
      {review && (
        <PreviewReviewDialog
          review={review}
          trigger={reviewTrigger.current}
          unavailable={entry.owner.error?.message}
          onClose={(stale) => {
            setReview(undefined);
            if (stale)
              setError(
                "The preview changed after this review. Reload the current configuration before editing it again.",
              );
          }}
          onStarted={(result) => {
            retainedReview.current = undefined;
            setReview(undefined);
            setChanges([]);
            setRefresh((value) => value + 1);
            setMessage(
              "Configuration submitted. Check Activity for startup progress.",
            );
            onStarted(result);
          }}
        />
      )}
    </>
  );
}

function BindingEditor({
  row,
  service,
  spec,
  existingKeys,
  onClose,
  onSave,
  busy,
  unavailable,
}: {
  row?: Binding;
  service?: string;
  spec: PreviewDescription["spec"];
  existingKeys: string[];
  onClose(): void;
  onSave(change: ConfigurationBindingChange): Promise<string | undefined>;
  busy: boolean;
  unavailable?: string;
}) {
  const [key, setKey] = useState(row?.key ?? "");
  const [type, setType] = useState(row ? bindingType(row.value) : "literal");
  const [reference, setReference] = useState(
    row?.value ? String(Object.values(row.value)[0]) : "",
  );
  const environment = spec.type === "environment";
  const primary = environment ? spec.primary : "";
  const services = environment ? Object.entries(spec.services).filter(([id, node]) =>
    type === "service" ? node.type !== "job" && id !== service : ["command", "static", "attach"].includes(node.type)) : [];
  const [error, setError] = useState("");
  const [replaceLiteral, setReplaceLiteral] = useState(
    !row || row.value !== null,
  );
  const value = useRef<HTMLTextAreaElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const clear = () => {
      if (value.current) value.current.value = "";
    };
    window.addEventListener("pagehide", clear);
    return () => {
      clear();
      window.removeEventListener("pagehide", clear);
    };
  }, []);
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || unavailable) return;
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
      ["PORT", "HOST", "PREVIEW_URL"].includes(key)
    ) {
      setError(
        "Use a variable name with letters, numbers and underscores. PORT, HOST and PREVIEW_URL are provided by Previewhost.",
      );
      return;
    }
    if (!row && existingKeys.includes(key)) {
      setError(
        "This variable already exists in the selected service. Edit its existing row.",
      );
      return;
    }
    const next =
      type === "literal"
        ? (value.current?.value ?? "")
        : ({ [type]: reference.trim() } as Exclude<EnvironmentValue, string>);
    if (type !== "literal" && !reference.trim()) {
      setError("Enter a reference.");
      return;
    }
    const problem = await onSave({ service, key, value: next });
    if (problem) setError(problem);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
        }}
      >
        <form
          onSubmit={save}
          autoComplete="off"
          className="flex min-w-0 flex-col gap-5"
        >
          <DialogHeader>
            <DialogTitle>{row ? "Edit variable" : "Add variable"}</DialogTitle>
            <DialogDescription>
              {service ? (
                <>
                  For <strong>{service}</strong> only.{" "}
                </>
              ) : null}
              This stages a configuration change. Save or Apply it from
              Configuration.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="binding-key">Variable name</FieldLabel>
              <Input
                id="binding-key"
                value={key}
                disabled={Boolean(row)}
                onChange={(event) => setKey(event.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="API_URL"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="binding-type">Value source</FieldLabel>
              <Select value={type} onValueChange={next => {
                setType(next);
                setReference(next === "publicUrl" ? primary : "");
                setError("");
              }}>
                <SelectTrigger id="binding-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(labels)
                      .filter(
                        ([kind]) =>
                          environment ||
                          ["literal", "secret", "fromEnv"].includes(kind),
                      )
                      .map(([kind, label]) => (
                        <SelectItem key={kind} value={kind}>
                          {label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {type === "literal" ? (
              <Field>
                {row?.value === null && (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="replace-literal"
                      checked={replaceLiteral}
                      onCheckedChange={(checked) =>
                        setReplaceLiteral(checked === true)
                      }
                    />
                    <FieldLabel htmlFor="replace-literal">
                      Replace the existing value
                    </FieldLabel>
                  </Field>
                )}
                <FieldLabel htmlFor="binding-value">
                  {row ? "Replacement value" : "Value"}
                </FieldLabel>
                <Textarea
                  id="binding-value"
                  ref={value}
                  disabled={!replaceLiteral}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                />
                <FieldDescription>
                  {row
                    ? "The existing value is never fetched. Replacing it with an empty value is allowed."
                    : "An empty value is allowed. Use a secret reference for credentials."}
                </FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="binding-reference">
                  {type === "secret" ? "Secret reference" : type === "fromEnv" ? "Input name"
                    : type === "publicUrl" ? "Primary service" : "Service"}
                </FieldLabel>
                {type === "secret" ? <SecretReferencePicker value={reference} onChange={setReference} />
                  : type === "fromEnv" ? <Input id="binding-reference" value={reference}
                    onChange={event => setReference(event.target.value)} required autoComplete="off" spellCheck={false} placeholder="DEV_TOKEN" />
                  : type === "publicUrl" ? <Input id="binding-reference" value={primary} readOnly />
                  : <Select value={reference} onValueChange={setReference}>
                    <SelectTrigger id="binding-reference"><SelectValue placeholder="Choose a service" /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      {services.map(([id]) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                    </SelectGroup></SelectContent>
                  </Select>}
                <FieldDescription>
                  {type === "secret"
                    ? "Uses a value stored in Secret Manager. Permission and missing values are handled in private setup."
                    : type === "fromEnv"
                      ? "Uses an input selected when the project runtime started, such as DEV_TOKEN. Other shell variables are unavailable."
                      : type === "service"
                        ? "Uses an internal HTTP or database connection URL. Waits for the selected service to be ready."
                        : type === "publicUrl"
                          ? "Uses the primary service’s numeric address, such as http://127.0.0.1:49837. Available only for the primary service."
                          : "Uses the selected service’s .localhost address for browser requests. Available for HTTP services only."}
                </FieldDescription>
                {(type === "service" || type === "browserUrl") && !services.length && <FieldDescription>No eligible services in this configuration.</FieldDescription>}
              </Field>
            )}
            {unavailable && <Notice title="Status unavailable" error>{unavailable}</Notice>}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || Boolean(unavailable) || (type === "literal" ? !replaceLiteral : !reference.trim())}
            >
              Keep change
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
