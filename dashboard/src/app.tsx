import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGridIcon, KeyRoundIcon, MoonIcon } from "lucide-react";
import { toast } from "sonner";
import { authenticated, call, errorMessage, type Mutate } from "./lib/api";
import {
  entries,
  shortProject,
  state,
  visibleEntries,
  type PreviewFilter,
  type Entry,
  type Owner,
} from "./lib/model";
import { Button } from "./components/ui/button";
import { Toggle } from "./components/ui/toggle";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";
import {
  AppLink,
  EmptyState,
  Loading,
  Notice,
  Path,
  SearchField,
  Status,
} from "./components/shared";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "./components/ui/table";
import { Preview } from "./preview";
import { PreviewMenu } from "./preview-actions";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./components/ui/select";
import { SecretManager } from "./secrets";
import brandSvg from "../../assets/previewhost.svg?raw";

const brandMark = brandSvg.replace(/<style>[\s\S]*?<\/style>/, "");

type Selection = { owner: string; name?: string } | "secrets" | undefined;

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
  const [selection, setSelection] = useState<Selection>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PreviewFilter>("all");
  const [revision, setRevision] = useState(0);
  const [acting, setActing] = useState(false);
  const mutation = useRef(false);
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
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
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
            setOwners((current) => (current.length ? current : [...result]));
            setLoaded(true);
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
  }, [revision]);
  const mutate: Mutate = useCallback(
    async <T,>(body: object, success: string | ((result: T) => string)) => {
      if (mutation.current) return;
      mutation.current = true;
      setActing(true);
      const id = toast.loading("Working…");
      try {
        const result = await call<T>(body);
        toast.success(
          typeof success === "function" ? success(result) : success,
          {
            id,
          },
        );
      } catch (error) {
        toast.error(errorMessage(error), {
          id,
          duration: Infinity,
          closeButton: true,
        });
      } finally {
        mutation.current = false;
        setActing(false);
        setRevision((value) => value + 1);
      }
    },
    [],
  );
  function select(value: Selection) {
    setSelection(value);
  }
  const all = owners.flatMap(entries);
  const filtered = visibleEntries(owners, query, filter);
  const selected =
    typeof selection === "object"
      ? owners.find((owner) => owner.id === selection.owner)
      : undefined;
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
            <SidebarTrigger size="icon" />
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
            <Button
              variant="outline"
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh
            </Button>
          </div>
        </header>
        <Navigation
          owners={owners}
          selection={selection}
          select={select}
          query={query}
          setQuery={setQuery}
          list={filtered}
          filter={filter}
          setFilter={setFilter}
          mutate={mutate}
          acting={acting}
        />
        <main className="main-workspace">
          {!authenticated ? (
            <div className="page">
              <EmptyState title="Open from your terminal">
                <code>previewhost dashboard</code>
              </EmptyState>
            </div>
          ) : selection === "secrets" ? (
            <SecretManager revision={revision} />
          ) : error ? (
            <div className="page">
              <Notice title="Dashboard disconnected" error>
                {error} Your previews may still be running. Use Refresh, or run{" "}
                <code>previewhost dashboard</code> to reopen it.
              </Notice>
            </div>
          ) : selection ? (
            selected &&
            entries(selected).some((entry) => entry.name === selection.name) ? (
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
              />
            ) : (
              <div className="page">
                <Notice title="Preview no longer listed">
                  Start through your agent or CLI to reconnect.
                </Notice>
              </div>
            )
          ) : (
            <div className="page">
              <h1>Previews</h1>
              {!loaded ? (
                <Loading>Connecting to local previews…</Loading>
              ) : !all.length ? (
                <EmptyState title="No previews running">
                  Ask your agent to preview an application with Previewhost.
                </EmptyState>
              ) : (
                <>
                  <p className="summary">
                    {all.filter((e) => e.preview?.active).length} running ·{" "}
                    {all.filter((e) => e.preview?.candidate).length} starting ·{" "}
                    {
                      all.filter(
                        (e) =>
                          e.owner.error ||
                          e.owner.configuration?.error ||
                          ["error", "warning"].includes(state(e).tone),
                      ).length
                    }{" "}
                    to review
                  </p>
                  {!filtered.length ? (
                    <EmptyState title="No matching previews">
                      Try another project or preview name.
                    </EmptyState>
                  ) : (
                    <Overview
                      entries={filtered}
                      mutate={mutate}
                      acting={acting}
                      select={(entry) =>
                        select({ owner: entry.owner.id, name: entry.name })
                      }
                    />
                  )}
                </>
              )}
            </div>
          )}
        </main>
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

function Navigation({
  owners,
  list,
  selection,
  select,
  query,
  setQuery,
  filter,
  setFilter,
  mutate,
  acting,
}: {
  owners: Owner[];
  list: Entry[];
  selection: Selection;
  select: (value: Selection) => void;
  query: string;
  setQuery: (value: string) => void;
  filter: PreviewFilter;
  setFilter: (value: PreviewFilter) => void;
  mutate: Mutate;
  acting: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  function navigate(value: Selection) {
    select(value);
    setOpenMobile(false);
  }
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!selection}
              onClick={() => navigate(undefined)}
            >
              <LayoutGridIcon />
              All previews
              <span className="ml-auto text-muted-foreground">
                {owners.flatMap(entries).length}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={selection === "secrets"}
              onClick={() => navigate("secrets")}
            >
              <KeyRoundIcon />
              Secret Manager
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="sidebar-find">
          <SearchField
            value={query}
            onChange={setQuery}
            label="Search previews"
          />
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as PreviewFilter)}
          >
            <SelectTrigger
              aria-label="Filter previews"
              className="sidebar-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="attention">Needs attention</SelectItem>
                <SelectItem value="stopped">Stopped / offline</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </SidebarHeader>
      <SidebarContent aria-label="Projects and previews">
        <SidebarGroup>
          <SidebarMenu>
            {list.map((entry) => (
              <SidebarMenuItem
                key={entry.owner.id + "/" + (entry.name ?? "")}
                className="preview-nav-row"
                data-active={
                  typeof selection === "object" &&
                  selection.owner === entry.owner.id &&
                  selection.name === entry.name
                }
              >
                <SidebarMenuButton
                  className="preview-nav"
                  isActive={
                    typeof selection === "object" &&
                    selection.owner === entry.owner.id &&
                    selection.name === entry.name
                  }
                  onClick={() =>
                    navigate({ owner: entry.owner.id, name: entry.name })
                  }
                >
                  <span className="nav-name">
                    {entry.name ?? shortProject(entry.owner)}
                  </span>
                  <Status
                    tone={entry.owner.error ? "error" : state(entry).tone}
                  >
                    {entry.owner.error ? "Unavailable" : state(entry).label}
                  </Status>
                  <Path value={entry.owner.project ?? "Unverified record"} />
                </SidebarMenuButton>
                <PreviewMenu entry={entry} mutate={mutate} acting={acting} />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {!list.length && (
            <p className="sidebar-empty">
              No matching previews
            </p>
          )}
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function Overview({
  entries,
  select,
  mutate,
  acting,
}: {
  entries: Entry[];
  select: (entry: Entry) => void;
  mutate: Mutate;
  acting: boolean;
}) {
  return (
    <div className="data-table overview-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Preview / worktree</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.owner.id + "/" + (entry.name ?? "")}>
              <TableCell>
                <Button
                  variant="link"
                  className="preview-name"
                  onClick={() => select(entry)}
                >
                  {entry.name ?? shortProject(entry.owner)}
                </Button>
                <Path value={entry.owner.project ?? "Unverified record"} />
              </TableCell>
              <TableCell>
                <Status tone={entry.owner.error ? "error" : state(entry).tone}>
                  {entry.owner.error ? "Unavailable" : state(entry).label}
                </Status>
                {(entry.owner.error || state(entry).note) && (
                  <p className="text-xs text-muted-foreground">
                    {entry.owner.error
                      ? "Owner did not respond"
                      : state(entry).note}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <div className="row-actions">
                  {entry.preview?.active && entry.preview.url && (
                    <AppLink url={entry.preview.url} />
                  )}
                  <PreviewMenu entry={entry} mutate={mutate} acting={acting} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
