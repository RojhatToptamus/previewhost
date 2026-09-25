import type { Mutate } from "./lib/api";
import { entries, entryLabel, projectGroups, state, visibleEntries, type Entry, type Owner, type PreviewFilter } from "./lib/model";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import { AppLink, EmptyState, Loading, SearchField, Status } from "./components/shared";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "./components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { PreviewMenu } from "./preview-actions";

export function Overview({ owners, loading, query, setQuery, filter, setFilter, select, mutate, acting, onNewPreview }: {
  owners: Owner[];
  loading: boolean;
  query: string;
  setQuery(value: string): void;
  filter: PreviewFilter;
  setFilter(value: PreviewFilter): void;
  select(entry: Entry): void;
  mutate: Mutate;
  acting: boolean;
  onNewPreview(): void;
}) {
  const all = owners.flatMap(entries);
  const list = visibleEntries(owners, query, filter);
  // Derive distinguishing labels from every worktree, not just the matches.
  const groups = new Map(projectGroups(owners).map(group => [group.id, group]));
  return (
    <div className="page overview-page">
      <div className="overview-heading"><h1>Previews</h1><Button onClick={onNewPreview} disabled={acting}>New preview</Button></div>
      <Tabs value={filter} onValueChange={value => setFilter(value as PreviewFilter)}>
        <div className="overview-toolbar">
          <TabsList variant="line" className="overview-filters" aria-label="Filter previews">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="attention">Needs attention</TabsTrigger>
            <TabsTrigger value="inactive">Inactive</TabsTrigger>
          </TabsList>
          <SearchField value={query} onChange={setQuery} label="Search previews" />
          {loading && all.length > 0 && <Spinner aria-label="Loading remaining previews" />}
        </div>
        <TabsContent value={filter}>
          {!list.length ? loading ? <Loading>Checking projects…</Loading> : !all.length ? (
            <EmptyState title="No previews yet">Use New preview to start from an existing project folder or worktree.</EmptyState>
          ) : (
            <EmptyState title="No matching previews">Try another folder, preview name, or status.</EmptyState>
          ) : (
            <div className="data-table overview-table">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Project / worktree</TableHead>
                  <TableHead className="status-column">Status</TableHead>
                  <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {list.map(entry => {
                    const group = groups.get(entry.owner.git?.commonDirectory ?? entry.owner.id)!;
                    const label = entryLabel(entry, group);
                    const context = [...new Set([group.label.name, group.label.qualifier, label.name, label.qualifier, entry.name].filter(Boolean))].join(" · ");
                    const worktree = [...new Set([entry.owner.git || label.name !== group.label.name ? label.name : "", label.qualifier].filter(Boolean))].join(" · ");
                    const status = state(entry);
                    return (
                      <TableRow key={entry.owner.id + "/" + (entry.name ?? "")} onClick={() => select(entry)}>
                        <TableCell>
                          <Button variant="link" className="preview-name overview-identity"
                            title={entry.owner.project ?? entry.owner.id} aria-label={context}>
                            <span className="overview-project">{group.label.name}{group.label.qualifier && <code>{group.label.qualifier}</code>}</span>
                            {worktree && <span className="overview-worktree">{worktree}</span>}
                          </Button>
                        </TableCell>
                        <TableCell className="status-column overview-status">
                          <Status tone={entry.owner.error ? "error" : status.tone}>
                            {entry.owner.error ? "Unavailable" : status.label}
                          </Status>
                          {status.note && !entry.owner.error && <p className="text-muted-foreground">{status.note}</p>}
                        </TableCell>
                        <TableCell><div className="row-actions" onClick={event => event.stopPropagation()}>
                          {entry.preview?.active && entry.preview.url && <AppLink url={entry.preview.url} />}
                          <PreviewMenu entry={entry} label={context} mutate={mutate} acting={acting} />
                        </div></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
