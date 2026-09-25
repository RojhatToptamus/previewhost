import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, LayoutGridIcon, KeyRoundIcon, MoreHorizontalIcon, PinIcon, PinOffIcon, ArrowUpIcon, ArrowDownIcon } from "lucide-react";
import { authenticated, call, errorMessage, type Mutate } from "./lib/api";
import { entryLabel, projectGroups, state, type Owner, type ProjectGroup } from "./lib/model";
import type { Selection } from "./lib/view-state";
import {
  Sidebar, SidebarHeader, SidebarContent, SidebarGroup,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, useSidebar,
} from "./components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "./components/ui/dropdown-menu";
import { Button } from "./components/ui/button";
import { Status } from "./components/shared";
import { PreviewMenu } from "./preview-actions";

type NavigationProps = {
  owners: Owner[];
  selection: Selection;
  select(value: Selection): void;
  mutate: Mutate;
  acting: boolean;
};
type Preferences = { pinnedProjects: string[] };

export function Navigation({ owners, selection, select, mutate, acting }: NavigationProps) {
  const { setOpenMobile } = useSidebar();
  // Disclosure stays here so closing the mobile Sheet keeps the navigation state.
  const [expanded, setExpanded] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const projectMenus = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterSave = useRef<string>(undefined);
  useEffect(() => {
    if (focusAfterSave.current) projectMenus.current.get(focusAfterSave.current)?.focus();
    focusAfterSave.current = undefined;
  }, [preferences]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    void call<Preferences>({ action: "navigationPreferences" }, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setPreferences(value); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [reload]);
  const pins = preferences?.pinnedProjects;
  const groups = projectGroups(owners).sort((a, b) =>
    a.label.name.localeCompare(b.label.name) || a.label.qualifier.localeCompare(b.label.qualifier) || a.id.localeCompare(b.id));
  const pinned = (pins ?? []).flatMap(id => groups.filter(group => group.id === id));
  const others = groups.filter(group => !pins?.includes(group.id));
  const selectedOwner = typeof selection === "object" ? owners.find(owner => owner.id === selection.owner) : undefined;
  const selectedGroup = selectedOwner ? selectedOwner.git?.commonDirectory ?? selectedOwner.id : undefined;
  const selectedName = typeof selection === "object" ? selection.name : undefined;
  useEffect(() => {
    if (!selectedGroup) return;
    setExpanded(current => current.includes(selectedGroup) ? current : [...current, selectedGroup]);
    if (!pins?.includes(selectedGroup)) setMoreOpen(true);
  }, [selectedGroup, selectedOwner?.id, selectedName, pins]);
  function navigate(value: Selection) {
    select(value);
    setOpenMobile(false);
  }
  async function save(pinnedProjects: string[], project: string) {
    if (saving || !preferences) return;
    setSaving(true);
    try {
      const saved = await call<Preferences>({ action: "saveNavigationPreferences", pinnedProjects });
      if (!pinnedProjects.includes(project)) setMoreOpen(true);
      focusAfterSave.current = project;
      setPreferences(saved);
      setError("");
    } catch (error) {
      setError(errorMessage(error));
      projectMenus.current.get(project)?.focus();
    } finally { setSaving(false); }
  }
  function renderGroup(group: ProjectGroup) {
    const index = pinned.findIndex(item => item.id === group.id);
    return <ProjectNavigation key={group.id} group={group}
      hidden={Boolean(pins?.length) && index < 0 && !moreOpen}
      open={expanded.includes(group.id)}
      onOpenChange={open => {
        if (open && !preferences) setMoreOpen(true);
        setExpanded(current => open ? [...current, group.id] : current.filter(id => id !== group.id));
      }}
      pinned={index >= 0} preferencesDisabled={!preferences || saving}
      menuRef={element => { if (element) projectMenus.current.set(group.id, element); else projectMenus.current.delete(group.id); }}
      onPin={() => void save(index >= 0 ? pins!.filter(id => id !== group.id) : [...pins!, group.id], group.id)}
      onMove={index >= 0 ? direction => {
        const neighbor = pinned[index + direction];
        if (!neighbor) return;
        const next = [...pins!], from = next.indexOf(group.id), to = next.indexOf(neighbor.id);
        [next[from], next[to]] = [next[to], next[from]];
        void save(next, group.id);
      } : undefined}
      canMoveUp={index > 0} canMoveDown={index >= 0 && index < pinned.length - 1}
      selection={selection} select={navigate} mutate={mutate} acting={acting} />;
  }
  return (
    <Sidebar>
      <SidebarHeader role="navigation" aria-label="Dashboard">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={!selection} aria-current={!selection ? "page" : undefined} onClick={() => navigate(undefined)}>
              <LayoutGridIcon /> Overview
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={selection === "secrets"} aria-current={selection === "secrets" ? "page" : undefined} onClick={() => navigate("secrets")}>
              <KeyRoundIcon /> Secret Manager
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="Projects">
        {error && <div className="navigation-error" role="alert">
          <p>{error}</p>
          {!preferences && <Button variant="ghost" size="sm" onClick={() => setReload(value => value + 1)}>Retry</Button>}
        </div>}
        {pinned.length > 0 && <p className="navigation-label">Pinned</p>}
        {[...pinned, ...others].flatMap((group, index) => [
          pins?.length && others.length > 0 && index === pinned.length
            ? <Button key="more-projects" variant="ghost" className="more-projects-toggle" aria-expanded={moreOpen}
                onClick={() => setMoreOpen(value => !value)}><ChevronRightIcon className={moreOpen ? "rotate-90" : ""} />More projects</Button>
            : null,
          renderGroup(group),
        ])}
      </SidebarContent>
    </Sidebar>
  );
}

function ProjectNavigation({ group, hidden, selection, select, mutate, acting, open, onOpenChange, menuRef, pinned, preferencesDisabled, onPin, onMove, canMoveUp, canMoveDown }: Omit<NavigationProps, "owners"> & {
  group: ProjectGroup;
  hidden: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  menuRef(element: HTMLButtonElement | null): void;
  pinned: boolean;
  preferencesDisabled: boolean;
  onPin(): void;
  onMove?: (direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const selected = typeof selection === "object" ? group.entries.find(entry =>
    entry.owner.id === selection.owner && (entry.name === selection.name || entry.owner.error)) : undefined;
  const ordered = [...group.entries].sort((a, b) => {
    const first = entryLabel(a, group), second = entryLabel(b, group);
    return first.name.localeCompare(second.name) || first.qualifier.localeCompare(second.qualifier) || a.owner.id.localeCompare(b.owner.id);
  });
  const selectedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [open, selected?.owner.id, selected?.name]);
  const projectLabel = [group.label.name, group.label.qualifier].filter(Boolean).join(" · ");
  return (
    <SidebarGroup className={hidden ? "project-navigation hidden" : "project-navigation"}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="project-nav-row">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="project-toggle" title={group.directory}
              aria-label={projectLabel} aria-description={`${group.entries.length} previews`}>
              <ChevronRightIcon className={open ? "rotate-90" : ""} />
              <span className="project-heading">
                <span>{group.label.name}</span>
                {group.label.qualifier && <code>{group.label.qualifier}</code>}
              </span>
              <span className="project-count" aria-hidden="true">{group.entries.length}</span>
            </Button>
          </CollapsibleTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button ref={menuRef} variant="ghost" size="icon-sm" aria-label={`Project options for ${projectLabel}`}><MoreHorizontalIcon /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={preferencesDisabled} onSelect={onPin}>
                {pinned ? <PinOffIcon /> : <PinIcon />}{pinned ? "Unpin project" : "Pin project"}
              </DropdownMenuItem>
              {onMove && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={preferencesDisabled || !canMoveUp} onSelect={() => onMove(-1)}><ArrowUpIcon />Move up</DropdownMenuItem>
                <DropdownMenuItem disabled={preferencesDisabled || !canMoveDown} onSelect={() => onMove(1)}><ArrowDownIcon />Move down</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          <SidebarMenu>
            {ordered.map(entry => {
              const label = entryLabel(entry, group);
              const context = [...new Set([group.label.name, group.label.qualifier, label.name, label.qualifier, entry.name].filter(Boolean))].join(" · ");
              const status = entry.owner.error ? { label: "Unavailable", tone: "error" } : state(entry);
              const showStatus = !["Ready", "Stopped"].includes(status.label);
              return (
                <SidebarMenuItem key={entry.owner.id + "/" + (entry.name ?? "")} className="preview-nav-row" data-active={entry === selected}>
                  <SidebarMenuButton ref={entry === selected ? selectedRow : undefined} className="preview-nav" isActive={entry === selected} aria-current={entry === selected ? "page" : undefined}
                    aria-label={`${context} · ${status.label}`}
                    title={[entry.owner.project ?? entry.owner.id, entry.name].filter(Boolean).join(" · ")}
                    onClick={() => select({ owner: entry.owner.id, name: entry.name })}>
                    <span className="nav-name">{label.name}</span>
                    {label.qualifier && <span className="nav-detail">{label.qualifier}</span>}
                    {showStatus && <Status tone={status.tone}>{status.label}</Status>}
                  </SidebarMenuButton>
                  <PreviewMenu entry={entry} label={context} mutate={mutate} acting={acting} />
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
