import { useEffect, useRef, useState, type ReactNode } from "react";
import type { KeystoreStatus as StoreStatus, SecretList as SecretPage } from "../../src/keystore";
import { toast } from "sonner";
import { KeyRoundIcon, MoreHorizontalIcon } from "lucide-react";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
} from "./components/ui/dropdown-menu";
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
import { Checkbox } from "./components/ui/checkbox";
import { Textarea } from "./components/ui/textarea";
import { ScrollArea } from "./components/ui/scroll-area";
import { Spinner } from "./components/ui/spinner";
import { EmptyState, Loading, Notice, SearchField } from "./components/shared";

export type SecretList = SecretPage & { keystore: StoreStatus };
export function SecretManager({ revision }: { revision: number }) {
  const [unlockRevision, setUnlockRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<SecretList>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const after = cursors.at(-1);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id?: string }>();
  useEffect(() => {
    if (editing) return;
    const controller = new AbortController();
    let pending = false;
    async function refresh(foreground = false) {
      if (pending || (!foreground && document.hidden)) return;
      if (foreground) setLoading(true);
      pending = true;
      try {
        const result = await call<SecretList>(
          { action: "listSecrets", query, after },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setList(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void refresh(true);
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [revision, editing, unlockRevision, query, after]);
  return (
    <div className="page secrets-page">
      <SecretManagerHeader status={list?.keystore} onUnlock={() => setUnlockRevision(value => value + 1)}>
        {list?.keystore.state === "unlocked" && <Button onClick={() => setEditing({})}>New secret</Button>}
      </SecretManagerHeader>
      {error && <Notice title="Secrets unavailable" error>{error}
        <Button variant="outline" onClick={() => setUnlockRevision(value => value + 1)}>Retry</Button>
      </Notice>}
      {!list ? (
        !error && <Loading>Loading secret references…</Loading>
      ) : list.keystore.state !== "unlocked" ? null : (
        <section className="secret-section" aria-busy={loading}>
          <div className="secret-toolbar">
            <SearchField
              value={query}
              onChange={value => { setQuery(value); setCursors([]); }}
              label="Search references"
            />
            <span className="secret-count" role="status">
              {loading ? "Loading…" : error ? null : `${list.ids.length} shown`}
            </span>
          </div>
          {error ? null : !list.ids.length ? (
            <EmptyState title={query.trim() ? "No matching references" : after ? "No more references" : "No stored secrets"}>
              {query.trim() ? "Try another reference name." : after ? "Go back to earlier references." : "Create a reference with New secret, or add one during a preview’s private setup."}
            </EmptyState>
          ) : (
            <ScrollArea
              key={after ?? "first"}
              className="secret-scroll"
              type="auto"
              aria-label="Stored references"
            >
              <div className="secret-list">
                {list.ids.map((id) => (
                  <div className="secret-row" key={id}>
                    <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <code>{id}</code>
                    <Button variant="ghost" size="sm" aria-label={"Edit " + id}
                      onClick={() => setEditing({ id })}>Edit</Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
          {(after || list.next) && <nav className="flex justify-end gap-2" aria-label="Reference pages">
            <Button variant="outline" size="sm" disabled={loading || !after}
              onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous</Button>
            <Button variant="outline" size="sm" disabled={loading || Boolean(error) || !list.next}
              onClick={() => setCursors(previous => [...previous, list.next!])}>Next</Button>
          </nav>}
        </section>
      )}
      {editing && <SecretEditor id={editing.id} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

function SecretEditor({ id, onClose }: { id?: string; onClose(): void }) {
  const [reference, setReference] = useState(id ?? "");
  const nameInput = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const value = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
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
  function close() {
    if (pending.current) return;
    if (value.current) value.current.value = "";
    setError("");
    onClose();
  }
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !value.current) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(reference)) {
      setError("Use 1–128 letters, numbers, dots, dashes, underscores or slashes, starting with a letter or number.");
      nameInput.current?.focus();
      return;
    }
    if (
      !value.current.value.length ||
      value.current.value.includes("\0") ||
      new TextEncoder().encode(value.current.value).length > 4096
    ) {
      setError("Enter 1–4096 UTF-8 bytes without NUL.");
      value.current.focus();
      return;
    }
    const input = { action: id ? "updateSecret" : "createSecret", id: reference, value: value.current.value };
    value.current.value = "";
    pending.current = true;
    setSaving(true);
    setError("");
    let saved = false;
    try {
      await call(input);
      saved = true;
      toast.success(id ? "Secret updated. Running apps are unchanged." : "Secret created.");
    } catch (error) {
      setError(
        error instanceof Error && error.cause
          ? error.message
          : "The save could not be confirmed. It may have completed. Enter your intended value to retry.",
      );
    } finally {
      input.value = "";
      pending.current = false;
      setSaving(false);
      if (saved) close();
      else requestAnimationFrame(() => value.current?.focus());
    }
  }
  return (
      <Dialog open onOpenChange={open => { if (!open) close(); }}>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            if (id) { event.preventDefault(); value.current?.focus(); }
          }}
          onCloseAutoFocus={event => {
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
              <DialogTitle>{id ? "Edit secret" : "New secret"}</DialogTitle>
              {id && <code className="break-anywhere">{id}</code>}
              <DialogDescription>
                {id ? "Replace this value for future starts in every project that uses this reference. Running apps stay unchanged."
                  : "Save a value for private setup. Runtime access requires separate approval."}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              {!id && <Field>
                <FieldLabel htmlFor="secret-reference">Reference name</FieldLabel>
                <Input id="secret-reference" ref={nameInput} value={reference} onChange={event => setReference(event.target.value)}
                  required maxLength={128} disabled={saving}
                  placeholder="my-project/dev/api" autoComplete="off" spellCheck={false} />
                <FieldDescription>Use a project-specific name. Reusing a reference shares its value after approval.</FieldDescription>
              </Field>}
              <Field data-invalid={Boolean(error)} data-disabled={saving}>
                <FieldLabel htmlFor="secret-value">{id ? "New value" : "Value"}</FieldLabel>
                <Textarea
                  id="secret-value"
                  ref={value}
                  className="private-value"
                  required
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-invalid={Boolean(error)}
                  aria-describedby="secret-help secret-error"
                />
                <FieldDescription id="secret-help">
                  Stored values are never shown. Saved in your encrypted keystore.
                </FieldDescription>
                {error && <FieldError id="secret-error">{error}</FieldError>}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Spinner data-icon="inline-start" />}
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
  );
}

function SecretManagerHeader({ status, onUnlock, children }: { status?: StoreStatus; onUnlock(): void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const creating = status?.state === "new";
  useEffect(() => {
    const clear = () => {
      if (password.current) password.current.value = "";
      if (confirmation.current) confirmation.current.value = "";
    };
    window.addEventListener("pagehide", clear);
    return () => { clear(); window.removeEventListener("pagehide", clear); };
  }, []);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = { action: "unlockKeystore", create: creating, password: password.current!.value,
      confirmation: confirmation.current?.value, remember: new FormData(event.currentTarget).has("remember") };
    password.current!.value = "";
    if (confirmation.current) confirmation.current.value = "";
    setBusy(true); setError("");
    try {
      const result = await call<StoreStatus>(input);
      setMessage(result.warning ?? ""); onUnlock();
    } catch (error) { setError(errorMessage(error)); }
    finally { input.password = ""; input.confirmation = ""; setBusy(false); password.current?.focus(); }
  }
  async function cache(action: "rememberKeystore" | "forgetKeystore") {
    setBusy(true); setError(""); setMessage("");
    try {
      await call({ action });
      setMessage(action === "rememberKeystore" ? "Automatic unlock saved on this Mac. Keep your password for recovery." : "Automatic unlock removed. Already unlocked sessions remain unlocked until shutdown.");
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <>
    <div className="secrets-heading">
      <h1>Secret Manager</h1>
      <div className="flex items-center gap-2">
      {status?.state === "unlocked" && status.canRemember && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" disabled={busy} aria-label="Keystore options">
            {busy ? <Spinner /> : <MoreHorizontalIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => void cache("rememberKeystore")}>
              Remember unlock on this Mac
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void cache("forgetKeystore")}>
              Forget automatic unlock
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
      {children}
      </div>
    </div>
    <p className="summary">Changes apply on the next start in every project using the reference.</p>
    {status && status.state !== "unlocked" && <form onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      <h2>{creating ? "Create your keystore" : "Unlock your keystore"}</h2>
      <p>{creating ? "Choose at least 12 characters. Keep your password safe; Previewhost cannot recover it." : "Unlock this dashboard session to manage stored values. Project owners unlock separately through private setup."}</p>
      <Field><FieldLabel htmlFor="vault-password">Keystore password</FieldLabel>
        <Input id="vault-password" ref={password} type="password" autoComplete={creating ? "new-password" : "current-password"} required maxLength={4096} disabled={busy} /></Field>
      {creating && <Field><FieldLabel htmlFor="vault-confirm">Confirm password</FieldLabel>
        <Input id="vault-confirm" ref={confirmation} type="password" autoComplete="new-password" required maxLength={4096} disabled={busy} /></Field>}
      {status.canRemember && <Field orientation="horizontal">
        <Checkbox id="remember-unlock" name="remember" disabled={busy} />
        <FieldLabel htmlFor="remember-unlock">Remember unlock on this Mac</FieldLabel>
      </Field>}
      <Button type="submit" disabled={busy} className="self-start">{busy ? "Working…" : creating ? "Create keystore" : "Unlock"}</Button>
    </form>}
    {(message || status?.warning) && <p role="status">{message || status?.warning}</p>}
    {error && <FieldError>{error}</FieldError>}
  </>;
}
