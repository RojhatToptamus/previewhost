import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import type { SecretList } from "./secrets";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Input } from "./components/ui/input";
import { FieldDescription, FieldError } from "./components/ui/field";
import { Spinner } from "./components/ui/spinner";

// Browsing returns reference names only. Selection stages a binding, never permission.
export function SecretReferencePicker({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<SecretList>();
  const [after, setAfter] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void call<SecretList>({ action: "listSecrets", query, after }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setList(result); })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, query, after, retry]);
  function choose(reference: string) { onChange(reference); setOpen(false); }
  const custom = query.trim();
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setAfter(undefined); } }}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" id="binding-reference" className="w-full justify-between font-normal">
        <span className="truncate">{value || "Choose or enter a reference"}</span><ChevronDownIcon />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="reference-picker" aria-label="Secret references">
      <Input ref={search} aria-label="Search or enter a reference" value={query} maxLength={128} autoComplete="off" spellCheck={false}
        placeholder="Search or enter a reference…"
        onChange={event => { setQuery(event.target.value); setAfter(undefined); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); options.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }
          if (event.key === "Enter") event.preventDefault();
        }} />
      <div ref={options} className="reference-options" onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
        event.preventDefault();
        buttons[(next + buttons.length) % buttons.length]?.focus();
      }}>
        {loading ? <p className="reference-message" role="status"><Spinner />Loading references…</p> : error ? <>
          <FieldError>{error}</FieldError><Button type="button" variant="ghost" onClick={() => { setRetry(value => value + 1); search.current?.focus(); }}>Retry</Button>
        </> : list?.keystore.state !== "unlocked" ? <FieldDescription className="reference-message">
          Unlock Secret Manager to browse stored references. You can still enter a name for private setup.
        </FieldDescription> : <>
          {list.ids.map(id => <Button type="button" key={id} variant="ghost" className="reference-option" onClick={() => choose(id)}>
            <span>{id}</span>{id === value && <CheckIcon aria-hidden="true" />}
          </Button>)}
          {!list.ids.length && <p className="reference-message">No matching references.</p>}
          {(after || list.next) && <div className="flex justify-between gap-2">
            {after && <Button type="button" variant="ghost" size="sm" onClick={() => { setAfter(undefined); search.current?.focus(); }}>First page</Button>}
            {list.next && <Button type="button" variant="ghost" size="sm" onClick={() => { setAfter(list.next); search.current?.focus(); }}>Next</Button>}
          </div>}
        </>}
        {custom && !list?.ids.includes(custom) && <Button type="button" variant="ghost" className="reference-option" onClick={() => choose(custom)}>
          <span>Use “{custom}”</span>
        </Button>}
      </div>
    </PopoverContent>
  </Popover>;
}
