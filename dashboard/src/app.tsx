import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGridIcon, KeyRoundIcon, MoonIcon } from "lucide-react";
import { toast } from "sonner";
import { authenticated, call, errorMessage, type Mutate } from "./lib/api";
import {
  entries,
  shortProject,
  state,
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
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
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
import { SecretManager } from "./secrets";

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
        const result = await call<Owner[]>(
          { action: "list" },
          controller.signal,
        );
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
    setQuery("");
  }
  const all = owners.flatMap(entries);
  const filtered = all.filter((entry) =>
    `${entry.owner.project ?? ""} ${entry.name ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selected =
    typeof selection === "object"
      ? owners.find((owner) => owner.id === selection.owner)
      : undefined;
  return (
    <TooltipProvider>
      <SidebarProvider className="app-shell">
        <header className="app-header">
          <div className="header-brand">
            <SidebarTrigger size="icon" />
            <Button
              variant="ghost"
              className="brand"
              onClick={() => select(undefined)}
            >
              previewhost
            </Button>
          </div>
          <div className="header-controls">
            <span className="connection">
              {error
                ? "Disconnected"
                : loaded
                  ? "Running locally"
                  : "Connecting…"}
            </span>
            <Toggle
              aria-label="Dark mode"
              pressed={dark}
              onPressedChange={setDark}
            >
              <MoonIcon />
              <span className="theme-label">Dark mode</span>
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
        />
        <main className="main-workspace">
          {!authenticated ? (
            <div className="page">
              <EmptyState title="Open from your terminal">
                <code>previewhost dashboard</code>
                <br />
                The launcher opens a private local session. No account is
                needed.
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
            selected ? (
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
                <Notice title="Project no longer listed">
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
  selection,
  select,
  query,
  setQuery,
}: {
  owners: Owner[];
  selection: Selection;
  select: (value: Selection) => void;
  query: string;
  setQuery: (value: string) => void;
}) {
  const { setOpenMobile } = useSidebar();
  function navigate(value: Selection) {
    select(value);
    setOpenMobile(false);
  }
  return (
    <Sidebar>
      <SidebarHeader>
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search previews"
        />
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
      </SidebarHeader>
      <SidebarContent aria-label="Projects and previews">
        {owners.map((owner) => {
          const list = entries(owner).filter((entry) =>
            `${owner.project} ${entry.name ?? ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
          );
          return list.length ? (
            <SidebarGroup key={owner.id}>
              {list.length > 1 && (
                <SidebarGroupLabel title={owner.project}>
                  {shortProject(owner)}
                </SidebarGroupLabel>
              )}
              <SidebarMenu>
                {list.map((entry) => (
                  <SidebarMenuItem key={entry.name ?? ""}>
                    <SidebarMenuButton
                      className="preview-nav"
                      isActive={
                        typeof selection === "object" &&
                        selection.owner === owner.id &&
                        selection.name === entry.name
                      }
                      onClick={() =>
                        navigate({ owner: owner.id, name: entry.name })
                      }
                    >
                      <span className="nav-name">
                        {entry.name ?? shortProject(owner)}
                      </span>
                      <Status tone={owner.error ? "error" : state(entry).tone}>
                        {owner.error ? "Unavailable" : state(entry).label}
                      </Status>
                      <Path value={owner.project ?? "Unverified record"} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ) : null;
        })}
      </SidebarContent>
      <SidebarFooter>
        <p className="text-xs text-muted-foreground">
          Closing this window leaves previews running.
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}

function Overview({
  entries,
  select,
}: {
  entries: Entry[];
  select: (entry: Entry) => void;
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
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
