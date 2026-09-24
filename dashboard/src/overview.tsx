import type { Mutate } from "./lib/api";
import { entries, isActive, lastAttempt, needsAttention, entryLabel, projectGroups, state, visibleEntries, type Entry, type Owner, type PreviewFilter } from "./lib/model";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import { AppLink, EmptyState, Loading, SearchField, Status } from "./components/shared";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "./components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "./components/ui/select";
import { PreviewMenu } from "./preview-actions";

export function Overview({ owners, loading, query, setQuery, filter, setFilter, select, mutate, acting }: {
  owners: Owner[];
  loading: boolean;
  query: string;
  setQuery(value: string): void;
  filter: PreviewFilter;
  setFilter(value: PreviewFilter): void;
  select(entry: Entry): void;
  mutate: Mutate;
  acting: boolean;
}) {
  const all = owners.flatMap(entries);
  const previews = all.filter(entry => entry.name !== undefined).length;
  const list = visibleEntries(owners, query, filter);
  const matches = new Set(list.map(entry => entry.owner.id + "/" + (entry.name ?? "")));
  // Labels use every worktree, so filtering cannot remove a distinguishing qualifier.
  const groups = projectGroups(owners, visibleEntries(owners, "", "all"))
    .map(group => ({ group, rows: group.entries.filter(entry => matches.has(entry.owner.id + "/" + (entry.name ?? ""))) }))
    .filter(item => item.rows.length);
  function show(status: PreviewFilter) {
    setFilter(status);
    setQuery("");
  }
  return (
    <div className="page">
      <h1>Previews</h1>
      <div className="summary overview-summary">
        <Button variant="link" aria-pressed={filter === "all"} onClick={() => show("all")}>{previews} {previews === 1 ? "preview" : "previews"}</Button>
        <span aria-hidden="true">·</span>
        <Button variant="link" aria-pressed={filter === "active"} onClick={() => show("active")}>{all.filter(isActive).length} active</Button>
        <span aria-hidden="true">·</span>
        <Button variant="link" aria-pressed={filter === "attention"} onClick={() => show("attention")}>{all.filter(needsAttention).length} need attention</Button>
        {loading && <Spinner className="ml-2 inline-block" aria-label="Loading remaining previews" />}
      </div>
      <div className="overview-toolbar">
        <SearchField value={query} onChange={setQuery} label="Search previews" />
        <Select value={filter} onValueChange={value => setFilter(value as PreviewFilter)}>
          <SelectTrigger aria-label="Filter previews"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="attention">Needs attention</SelectItem>
            <SelectItem value="stopped">Stopped / offline</SelectItem>
          </SelectGroup></SelectContent>
        </Select>
      </div>
      {!list.length ? loading ? <Loading>Checking projects…</Loading> : !all.length ? (
        <EmptyState title="No previews yet">Ask your agent to preview an application with Previewhost.</EmptyState>
      ) : (
        <EmptyState title="No matching previews">Try another folder, preview name, or status.</EmptyState>
      ) : (
        <div className="data-table overview-table">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Preview / worktree</TableHead>
              <TableHead className="status-column">Status</TableHead>
              <TableHead className="attempt-column">Last attempt</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow></TableHeader>
            {groups.map(({ group, rows }) => <TableBody key={group.id} aria-label={[group.label.name, group.label.qualifier].filter(Boolean).join(" · ")}>
              <TableRow className="project-section-heading">
                <TableHead scope="rowgroup" colSpan={2}>
                  <h2>{group.label.name}</h2>
                  {group.label.qualifier && <code title={group.directory}>{group.label.qualifier}</code>}
                </TableHead>
                <TableCell className="attempt-column" />
                <TableCell />
              </TableRow>
              {rows.map(entry => {
                const label = entryLabel(entry, group);
                const context = [...new Set([group.label.name, group.label.qualifier, label.name, label.qualifier, entry.name].filter(Boolean))].join(" · ");
                const attempt = lastAttempt(entry);
                const status = state(entry);
                return (
                  <TableRow key={entry.owner.id + "/" + (entry.name ?? "")}>
                    <TableCell>
                      <Button variant="link" className="preview-name" onClick={() => select(entry)}
                        title={entry.owner.project ?? entry.owner.id}
                        aria-label={context}>
                        {label.name}
                      </Button>
                      {label.qualifier && <code className="project-qualifier" title={entry.owner.project}>{label.qualifier}</code>}
                    </TableCell>
                    <TableCell className="status-column">
                      <Status tone={entry.owner.error ? "error" : status.tone}>
                        {entry.owner.error ? "Unavailable" : status.label}
                      </Status>
                      {status.note && !entry.owner.error && <p className="text-muted-foreground">{status.note}</p>}
                    </TableCell>
                    <TableCell className="attempt-column">
                      {attempt ? <time dateTime={attempt.startedAt} title={new Date(attempt.startedAt).toLocaleString()}>
                        {new Date(attempt.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        {" · "}{new Date(attempt.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </time> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell><div className="row-actions">
                      {entry.preview?.active && entry.preview.url && <AppLink url={entry.preview.url} />}
                      <PreviewMenu entry={entry} label={context} mutate={mutate} acting={acting} />
                    </div></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>)}
          </Table>
        </div>
      )}
    </div>
  );
}
