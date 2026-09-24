import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, LayoutGridIcon, KeyRoundIcon } from "lucide-react";
import type { Mutate } from "./lib/api";
import { entryLabel, projectGroups, state, type Owner, type ProjectGroup } from "./lib/model";
import type { Selection } from "./lib/view-state";
import {
  Sidebar, SidebarHeader, SidebarContent, SidebarGroup,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, useSidebar,
} from "./components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
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

export function Navigation({ owners, selection, select, mutate, acting }: NavigationProps) {
  const { setOpenMobile } = useSidebar();
  // Keep disclosure choices here so closing the mobile Sheet does not reset them.
  const [openGroup, setOpenGroup] = useState<string>();
  const groups = projectGroups(owners).sort((a, b) =>
    a.label.name.localeCompare(b.label.name) || a.label.qualifier.localeCompare(b.label.qualifier) || a.id.localeCompare(b.id));
  const selectedOwner = typeof selection === "object" ? owners.find(owner => owner.id === selection.owner) : undefined;
  const selectedGroup = selectedOwner ? selectedOwner.git?.commonDirectory ?? selectedOwner.id : undefined;
  const selectedName = typeof selection === "object" ? selection.name : undefined;
  useEffect(() => {
    if (selectedGroup) setOpenGroup(selectedGroup);
  }, [selectedGroup, selectedOwner?.id, selectedName]);
  function navigate(value: Selection) {
    select(value);
    setOpenMobile(false);
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
        {groups.map(group => <ProjectNavigation key={group.id} group={group}
          open={openGroup === group.id}
          onOpenChange={open => setOpenGroup(open ? group.id : undefined)}
          selection={selection} select={navigate} mutate={mutate} acting={acting} />)}
      </SidebarContent>
    </Sidebar>
  );
}

function ProjectNavigation({ group, selection, select, mutate, acting, open, onOpenChange }: Omit<NavigationProps, "owners"> & {
  group: ProjectGroup;
  open: boolean;
  onOpenChange(open: boolean): void;
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
  return (
    <SidebarGroup className="project-navigation">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="project-toggle" title={group.directory}
            aria-label={[group.label.name, group.label.qualifier].filter(Boolean).join(" · ")}>
            <ChevronRightIcon className={open ? "rotate-90" : ""} />
            <span className="project-heading">
              <span>{group.label.name}</span>
              {group.label.qualifier && <code>{group.label.qualifier}</code>}
            </span>
            <span className="project-count">{group.entries.length}</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu>
            {ordered.map(entry => {
              const label = entryLabel(entry, group);
              const context = [...new Set([group.label.name, group.label.qualifier, label.name, label.qualifier, entry.name].filter(Boolean))].join(" · ");
              const status = entry.owner.error ? { label: "Unavailable", tone: "error" } : state(entry);
              return (
                <SidebarMenuItem key={entry.owner.id + "/" + (entry.name ?? "")} className="preview-nav-row" data-active={entry === selected}>
                  <SidebarMenuButton ref={entry === selected ? selectedRow : undefined} className="preview-nav" isActive={entry === selected} aria-current={entry === selected ? "page" : undefined}
                    aria-label={`${context} · ${status.label}`}
                    title={[entry.owner.project ?? entry.owner.id, entry.name].filter(Boolean).join(" · ")}
                    onClick={() => select({ owner: entry.owner.id, name: entry.name })}>
                    <span className="nav-name">{label.name}</span>
                    {label.qualifier && <span className="nav-detail">{label.qualifier}</span>}
                    <Status tone={status.tone}>{status.label}</Status>
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
