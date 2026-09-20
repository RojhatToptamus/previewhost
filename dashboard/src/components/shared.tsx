import { useRef, type ReactNode } from "react";
import { CopyIcon, SearchIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "./ui/input-group";
import { Spinner } from "./ui/spinner";
import { cn } from "../lib/utils";

export function Path({ value }: { value: string }) {
  const parts = value.split("/");
  const folder = parts.pop()!;
  const directory = parts.pop();
  return (
    <span className="path" title={value}>
      <span className="path-parent">
        {parts.length ? parts.join("/") + "/" : ""}
      </span>
      <span className="path-tail">
        <span className="path-directory">
          {directory === undefined ? "" : directory + "/"}
        </span>
        <span className="path-folder">{folder}</span>
      </span>
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy path",
}: {
  value: string;
  label?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => toast.success("Copied"),
          () =>
            toast.error(
              "Copy was unavailable. Select and copy the text instead.",
            ),
        );
      }}
    >
      <CopyIcon />
    </Button>
  );
}

export function AppLink({
  url,
  children = "Open app",
  primary = false,
}: {
  url: string;
  children?: ReactNode;
  primary?: boolean;
}) {
  let safe = false;
  try {
    const parsed = new URL(url);
    safe =
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname.endsWith(".localhost"));
  } catch {
    /* Omit unsafe links. */
  }
  if (!safe) return null;
  return (
    <Button variant={primary ? "default" : "outline"} asChild>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    </Button>
  );
}

export function Status({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={cn("status", tone)}>{children}</span>;
}
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <h2 className="section-label">{title}</h2>
      {children}
    </section>
  );
}
export function Notice({
  title,
  children,
  error = false,
}: {
  title: string;
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Alert variant={error ? "destructive" : "default"}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-muted-foreground" role="status">
      <Spinner />
      {children}
    </p>
  );
}
export function SearchField({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <InputGroup className="min-w-0">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={input}
        type="search"
        aria-label={label}
        placeholder={label + "…"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            disabled={disabled}
            size="icon-xs"
            aria-label={"Clear " + label.toLowerCase()}
            onClick={() => {
              onChange("");
              input.current?.focus();
            }}
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
