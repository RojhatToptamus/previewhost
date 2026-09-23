import { useEffect, useRef, useState } from "react";
import type { KeystoreStatus as StoreStatus, SecretList as SecretPage } from "../../src/keystore";
import { toast } from "sonner";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogTrigger,
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
import { ScrollArea } from "./components/ui/scroll-area";
import { Spinner } from "./components/ui/spinner";
import { EmptyState, Loading, Notice, SearchField } from "./components/shared";

type SecretList = SecretPage & { keystore: StoreStatus };
export function SecretManager({ revision }: { revision: number }) {
  const [unlockRevision, setUnlockRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<SecretList>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const after = cursors.at(-1);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string>();
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
      <h1>Secret Manager</h1>
      <p className="summary">
        Changes apply on the next start in every project using the reference.
      </p>
      {list && <KeystoreControls status={list.keystore} onUnlock={() => setUnlockRevision(value => value + 1)} />}
      {error && <Notice title="Secrets unavailable" error>{error} Use Refresh to try again.</Notice>}
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
              {query.trim() ? "Try another reference name." : after ? "Go back to earlier references." : "Add secrets through private setup when your agent requests them."}
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
                  <SecretRow
                    key={id}
                    id={id}
                    disabled={loading}
                    open={editing === id}
                    setOpen={(open) => setEditing(open ? id : undefined)}
                  />
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
    </div>
  );
}

function SecretRow({
  id,
  disabled,
  open,
  setOpen,
}: {
  id: string;
  disabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const value = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const clear = () => {
      if (value.current) value.current.value = "";
    };
    window.addEventListener("pagehide", clear);
    return () => {
      clear();
      window.removeEventListener("pagehide", clear);
    };
  }, [open]);
  function changeOpen(next: boolean) {
    if (pending.current) return;
    if (value.current) value.current.value = "";
    setError("");
    setOpen(next);
  }
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !value.current) return;
    if (
      !value.current.value.length ||
      value.current.value.includes("\0") ||
      new TextEncoder().encode(value.current.value).length > 4096
    ) {
      setError("Enter 1–4096 UTF-8 bytes without NUL.");
      value.current.focus();
      return;
    }
    const input = { action: "updateSecret", id, value: value.current.value };
    value.current.value = "";
    pending.current = true;
    setSaving(true);
    setError("");
    let saved = false;
    try {
      await call(input);
      saved = true;
      toast.success("Secret updated. Running apps are unchanged.");
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
      if (saved) changeOpen(false);
      else requestAnimationFrame(() => value.current?.focus());
    }
  }
  return (
    <div className="secret-row">
      <code>{id}</code>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} aria-label={"Edit " + id}>
            Edit
          </Button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            value.current?.focus();
          }}
        >
          <form
            onSubmit={save}
            autoComplete="off"
            className="flex min-w-0 flex-col gap-5"
          >
            <DialogHeader>
              <DialogTitle>Edit secret</DialogTitle>
              <code className="break-anywhere">{id}</code>
              <DialogDescription>
                Replace this value for future starts in every project that uses
                this reference. Running apps stay unchanged.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field data-invalid={Boolean(error)} data-disabled={saving}>
                <FieldLabel htmlFor="secret-value">New value</FieldLabel>
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
                onClick={() => changeOpen(false)}
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
    </div>
  );
}

function KeystoreControls({ status, onUnlock }: { status: StoreStatus; onUnlock(): void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const remember = useRef<HTMLInputElement>(null);
  const creating = status.state === "new";
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
      confirmation: confirmation.current?.value, remember: remember.current?.checked ?? false };
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
  return <section className="mb-6 flex max-w-xl flex-col gap-4">
    {status.state !== "unlocked" ? <form onSubmit={submit} className="flex flex-col gap-4">
      <h2>{creating ? "Create your keystore" : "Unlock your keystore"}</h2>
      <p>{creating ? "Choose at least 12 characters. Keep your password safe; Previewhost cannot recover it." : "Unlock this dashboard session to manage stored values. Project owners unlock separately through private setup."}</p>
      <Field><FieldLabel htmlFor="vault-password">Keystore password</FieldLabel>
        <Input id="vault-password" ref={password} type="password" autoComplete={creating ? "new-password" : "current-password"} required maxLength={4096} disabled={busy} /></Field>
      {creating && <Field><FieldLabel htmlFor="vault-confirm">Confirm password</FieldLabel>
        <Input id="vault-confirm" ref={confirmation} type="password" autoComplete="new-password" required maxLength={4096} disabled={busy} /></Field>}
      {status.canRemember && <label className="flex items-center gap-2"><input type="checkbox" ref={remember} disabled={busy} />Remember unlock on this Mac</label>}
      <Button type="submit" disabled={busy} className="self-start">{busy ? "Working…" : creating ? "Create keystore" : "Unlock"}</Button>
    </form> : status.canRemember ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy} onClick={() => void cache("rememberKeystore")}>Remember unlock on this Mac</Button>
      <Button variant="outline" disabled={busy} onClick={() => void cache("forgetKeystore")}>Forget automatic unlock</Button>
    </div> : null}
    {(message || status.warning) && <p role="status">{message || status.warning}</p>}
    {error && <FieldError>{error}</FieldError>}
  </section>;
}
