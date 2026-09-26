import { useEffect, useRef, useState } from "react";
import { PlusIcon, ChevronRightIcon, LayoutGridIcon, KeyRoundIcon, MoreHorizontalIcon, PinIcon, PinOffIcon, ArrowUpIcon, ArrowDownIcon } from "lucide-react";
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
  onNewPreview(): void;
};
type Preferences = { pinnedProjects: string[] };

export function Navigation({ owners, selection, select, mutate, acting, onNewPreview }: NavigationProps) {
  const { setOpenMobile } = useSidebar();
  // Disclosure stays here so closing the mobile Sheet keeps the navigation state.
  const [expanded, setExpanded] = useState<string[]>([]);
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
  }, [selectedGroup, selectedOwner?.id, selectedName]);
  function navigate(value: Selection) {
    select(value);
    setOpenMobile(false);
  }
  async function save(pinnedProjects: string[], project: string) {
    if (saving || !preferences) return;
    setSaving(true);
    try {
      const saved = await call<Preferences>({ action: "saveNavigationPreferences", pinnedProjects });
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
      open={expanded.includes(group.id)}
      onOpenChange={open => {
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
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => { setOpenMobile(false); onNewPreview(); }}>
              <PlusIcon /> New preview
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
          others.length > 0 && index === pinned.length
            ? <p key="projects-label" className="navigation-label">Projects</p>
            : null,
          renderGroup(group),
        ])}
      </SidebarContent>
    </Sidebar>
  );
}

function ProjectNavigation({ group, selection, select, mutate, acting, open, onOpenChange, menuRef, pinned, preferencesDisabled, onPin, onMove, canMoveUp, canMoveDown }: Omit<NavigationProps, "owners" | "onNewPreview"> & {
  group: ProjectGroup;
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
    <SidebarGroup className="project-navigation">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="project-nav-row">
          <CollapsibleTrigger asChild>
            <SidebarMenuButton className="project-toggle" title={group.directory}
              aria-label={projectLabel} aria-description={`${group.entries.length} previews`}>
              <ChevronRightIcon className={open ? "rotate-90" : ""} />
              <span className="project-heading">
                <span>{group.label.name}</span>
                {group.label.qualifier && <code>{group.label.qualifier}</code>}
              </span>
              <span className="project-count" aria-hidden="true">{group.entries.length}</span>
            </SidebarMenuButton>
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
