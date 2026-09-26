import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoonIcon } from "lucide-react";
import { toast } from "sonner";
import { authenticated, call, errorMessage, type Mutate } from "./lib/api";
import { entries, entryLabel, projectGroups, shortProject, type PreviewFilter, type Owner } from "./lib/model";
import { Button } from "./components/ui/button";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator } from "./components/ui/breadcrumb";
import { Separator } from "./components/ui/separator";
import { Toggle } from "./components/ui/toggle";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { EmptyState, Loading, Notice, Path } from "./components/shared";
import { Preview } from "./preview";
import { SecretManager } from "./secrets";
import { Navigation } from "./navigation";
import { Overview } from "./overview";
import { NewPreview } from "./new-preview";
import type { LaunchResult } from "./preview-workflow";
import { useSelection } from "./lib/view-state";
import brandSvg from "../../assets/previewhost.svg?raw";

const brandMark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");

export function App() {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("previewhost.theme") === "dark";
    } catch {
      return false;
    }
  });
  const [owners, setOwners] = useState<Owner[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selection, select] = useSelection();
  const workspace = useRef<HTMLElement>(null);
  useLayoutEffect(() => { workspace.current?.scrollTo(0, 0); }, [selection]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PreviewFilter>("all");
  const [revision, setRevision] = useState(0);
  const [acting, setActing] = useState(false);
  const [creating, setCreating] = useState<{ project?: string; resumeId?: string }>();
  const mutation = useRef(false);
  const selectedOwner = typeof selection === "object" ? selection.owner : undefined;
  useEffect(() => {
    document.body.classList.toggle("ph-dark", dark);
    try {
      localStorage.setItem("previewhost.theme", dark ? "dark" : "light");
    } catch {
      /* Theme still works for this session. */
    }
  }, [dark]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    let pending = false;
    setLoaded(false);
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        // A selected preview should not wait behind unrelated, unreachable owners.
        if (selectedOwner) {
          try {
            const owner = await call<Owner>({ action: "recheck", owner: selectedOwner }, controller.signal);
            if (!controller.signal.aborted) setOwners(current => mergeOwners(current, [owner]));
          } catch (error) {
            if (!controller.signal.aborted) {
              setOwners(current => ownerReadFailed(current, selectedOwner, error));
            }
          }
        }
        const result: Owner[] = [];
        let after: string | undefined;
        do {
          const page = await call<{ owners: Owner[]; next?: string }>(
            { action: "list", after },
            controller.signal,
          );
          result.push(...page.owners);
          after = page.next;
          if (!controller.signal.aborted && after) {
            setOwners(current => mergeOwners(current, page.owners));
          }
        } while (after && !controller.signal.aborted);
        if (!controller.signal.aborted) {
          setOwners(result);
          setLoaded(true);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [revision, selectedOwner]);
  const mutate: Mutate = useCallback(
    async <T,>(body: object, success?: string | ((result: T) => string)) => {
      if (mutation.current)
        return {
          ok: false,
          error:
            "Another action is in progress. Recheck status before trying again.",
        };
      mutation.current = true;
      setActing(true);
      // Confirmations own their feedback. Other actions use the shared toast.
      const id = success === undefined ? undefined : toast.loading("Working…");
      try {
        const result = await call<T>(body);
        if ("action" in body && body.action === "recheck") {
          setOwners(current => mergeOwners(current, [result as Owner]));
        }
        if (success !== undefined)
          toast.success(
            typeof success === "function" ? success(result) : success,
            { id },
          );
        return { ok: true, result };
      } catch (error) {
        if ("action" in body && body.action === "recheck" && "owner" in body && typeof body.owner === "string") {
          const ownerId = body.owner;
          setOwners(current => ownerReadFailed(current, ownerId, error));
        }
        const message =
          error instanceof Error && error.cause
            ? errorMessage(error)
            : "No response was received. The action may have completed. Recheck status before trying again.";
        if (success !== undefined)
          toast.error(message, { id, duration: Infinity, closeButton: true });
        return { ok: false, error: message };
      } finally {
        mutation.current = false;
        setActing(false);
        setRevision((value) => value + 1);
      }
    },
    [],
  );
  const selected =
    typeof selection === "object"
      ? owners.find((owner) => owner.id === selection.owner)
      : undefined;
  function previewStarted(result: LaunchResult) {
    setCreating(undefined);
    setRevision(value => value + 1);
    select({ owner: result.owner, name: result.name });
  }
  const group = selected && projectGroups(owners).find(group => group.entries.some(entry => entry.owner.id === selected.id));
  const selectedEntry = group?.entries.find(entry => entry.owner.id === selected?.id && entry.name === (typeof selection === "object" ? selection.name : undefined));
  const label = selectedEntry && group ? entryLabel(selectedEntry, group) : undefined;
  const location = selected
    ? [...new Set([group?.label.name ?? shortProject(selected), group?.label.qualifier, label?.name, label?.qualifier].filter(Boolean))].join(" · ")
    : "Preview";
  const pageTitle = selection === "secrets" ? "Secret Manager" : typeof selection === "object" ? location : "Previews";
  useEffect(() => { document.title = `${pageTitle} · Previewhost`; }, [pageTitle]);
  return (
    <TooltipProvider>
      <SidebarProvider className="app-shell">
        <header className="app-header">
          <div className="header-brand">
            <Button
              variant="ghost"
              className="brand"
              onClick={() => select(undefined)}
            >
              <span
                className="brand-icon"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: brandMark }}
              />
              previewhost
            </Button>
          </div>
          <div className="header-navigation">
            <SidebarTrigger size="icon" />
            <Separator orientation="vertical" className="h-4 data-vertical:self-center" />
            <Breadcrumb>
              <BreadcrumbList>
                {selection && <>
                  <BreadcrumbItem className="breadcrumb-parent shrink-0">
                    <BreadcrumbLink asChild><button onClick={() => select(undefined)}>Previews</button></BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="breadcrumb-parent" />
                </>}
                <BreadcrumbItem>
                  <BreadcrumbPage title={selected ? location : undefined}>
                    {selection === "secrets" ? "Secret Manager" : selection ? location : "Previews"}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="header-controls">
            <Toggle
              aria-label="Dark mode"
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              className="size-8 p-0"
              pressed={dark}
              onPressedChange={setDark}
            >
              <MoonIcon />
            </Toggle>
          </div>
        </header>
        <Navigation
          owners={owners}
          selection={selection}
          select={select}
          mutate={mutate}
          acting={acting}
        />
        <main className="main-workspace" ref={workspace}>
          {authenticated && selection !== "secrets" && error && (
            <div className="page">
              <Notice title="Dashboard disconnected" error>
                {error} Your previews may still be running.
                <Button variant="outline" onClick={() => setRevision(value => value + 1)}>Retry connection</Button>
              </Notice>
            </div>
          )}
          {!authenticated ? (
            <div className="page">
              <EmptyState title="Open from your terminal">
                <code>previewhost dashboard</code>
              </EmptyState>
            </div>
          ) : selection === "secrets" ? (
            <SecretManager revision={revision} />
          ) : selection ? (
            selected &&
            (selected.error || entries(selected).some((entry) => entry.name === selection.name)) ? (
              <Preview
                key={selected.id + "/" + (selection.name ?? "")}
                entry={{
                  owner: selected,
                  name: selection.name,
                  preview: selected.previews?.find(
                    (preview) => preview.name === selection.name,
                  ),
                }}
                mutate={mutate}
                acting={acting}
                revision={revision}
                onRefresh={() => setRevision(value => value + 1)}
                onStarted={previewStarted}
                onPrepare={(resumeId) => setCreating({ project: selected.project, resumeId })}
              />
            ) : (
              <div className="page">
                {selected && selection.name === undefined ? <>
                  <h1>{shortProject(selected)}</h1>
                  <Path value={selected.project ?? selected.id} />
                  <p className="summary">Choose a preview</p>
                  <div className="flex flex-wrap gap-2">
                    {entries(selected).map(entry => <Button key={entry.name} variant="outline"
                      onClick={() => select({ owner: selected.id, name: entry.name })}>{entry.name}</Button>)}
                  </div>
                </> : !loaded ? <Loading /> : <Notice title="Preview no longer listed">
                  Start through your agent or CLI to reconnect.
                </Notice>}
              </div>
            )
          ) : (
            <Overview owners={owners} loading={!loaded}
              query={query} setQuery={setQuery} filter={filter} setFilter={setFilter}
              mutate={mutate} acting={acting}
              onNewPreview={() => setCreating({})}
              select={entry => select({ owner: entry.owner.id, name: entry.name })} />
          )}
        </main>
        {creating && <NewPreview {...creating} onClose={() => setCreating(undefined)} onStarted={previewStarted} />}
        <Toaster
          theme={dark ? "dark" : "light"}
          position="bottom-right"
          closeButton
          visibleToasts={2}
        />
      </SidebarProvider>
    </TooltipProvider>
  );
}

function mergeOwners(current: Owner[], page: Owner[]) {
  const byId = new Map(current.map(owner => [owner.id, owner]));
  for (const owner of page) byId.set(owner.id, owner);
  return [...byId.values()];
}

function ownerReadFailed(current: Owner[], id: string, error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause && cause.code === "NOT_FOUND") {
    return current.filter(owner => owner.id !== id);
  }
  return mergeOwners(current, [{
    id,
    project: current.find(owner => owner.id === id)?.project,
    git: current.find(owner => owner.id === id)?.git,
    error: { message: errorMessage(error) },
  }]);
}
