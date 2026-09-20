import { useEffect, useRef, useState } from "react";
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
import { Textarea } from "./components/ui/textarea";
import { ScrollArea } from "./components/ui/scroll-area";
import { Spinner } from "./components/ui/spinner";
import { EmptyState, Loading, Notice } from "./components/shared";

type SecretList = { ids: string[]; truncated: boolean };
export function SecretManager({
  revision,
  query,
}: {
  revision: number;
  query: string;
}) {
  const [list, setList] = useState<SecretList>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string>();
  useEffect(() => {
    if (editing) return;
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const result = await call<SecretList>(
          { action: "listSecrets" },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setList(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          setList(undefined);
        }
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [revision, editing]);
  const ids =
    list?.ids.filter((id) =>
      id.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [];
  return (
    <div className="page secrets-page">
      <h1>Secret Manager</h1>
      <p className="summary">
        Stored Keychain references. Values are never shown.
      </p>
      <p className="text-muted-foreground">
        Changes apply on the next start in every project using the reference.
      </p>
      {error ? (
        <Notice title="Secrets unavailable" error>
          {error} Use Refresh to try again.
        </Notice>
      ) : !list ? (
        <Loading>Loading secret references…</Loading>
      ) : !list.ids.length ? (
        <EmptyState title="No stored secrets">
          Ask your agent to preview an application. When it needs a secret,
          enter the value in private setup. Its reference will appear here.
        </EmptyState>
      ) : (
        <section className="secret-section">
          <h2 className="section-label">Stored references</h2>
          {list.truncated && (
            <p className="warning">
              Showing the first 128 references returned by Keychain. Additional
              entries are not listed.
            </p>
          )}
          {!ids.length ? (
            <EmptyState title="No matching references">
              Try another reference name.
            </EmptyState>
          ) : (
            <ScrollArea
              className="secret-scroll"
              type="auto"
              aria-label="Stored references"
            >
              <div className="secret-list">
                {ids.map((id) => (
                  <SecretRow
                    key={id}
                    id={id}
                    open={editing === id}
                    setOpen={(open) => setEditing(open ? id : undefined)}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </section>
      )}
    </div>
  );
}

function SecretRow({
  id,
  open,
  setOpen,
}: {
  id: string;
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
      toast.success(
        "Secret updated. Future starts use the new value; running apps are unchanged.",
      );
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
          <Button variant="outline" size="sm" aria-label={"Edit " + id}>
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
                  Stored values are never shown. Saved securely in macOS
                  Keychain.
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
