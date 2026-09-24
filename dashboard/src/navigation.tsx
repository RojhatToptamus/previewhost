import { useEffect, useState } from "react";
import { ChevronRightIcon, LayoutGridIcon, KeyRoundIcon } from "lucide-react";
import type { Mutate } from "./lib/api";
import { entryLabel, projectGroups, state, visibleEntries, type Owner, type ProjectGroup } from "./lib/model";
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
  const groups = projectGroups(owners, visibleEntries(owners, "", "all"));
  function navigate(value: Selection) {
    select(value);
    setOpenMobile(false);
  }
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={!selection} onClick={() => navigate(undefined)}>
              <LayoutGridIcon /> Overview
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={selection === "secrets"} onClick={() => navigate("secrets")}>
              <KeyRoundIcon /> Secret Manager
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent aria-label="Projects">
        {groups.map(group => <ProjectNavigation key={group.id} group={group}
          selection={selection} select={navigate} mutate={mutate} acting={acting} />)}
      </SidebarContent>
    </Sidebar>
  );
}

function ProjectNavigation({ group, selection, select, mutate, acting }: Omit<NavigationProps, "owners"> & { group: ProjectGroup }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // Keep the action target reachable when Stop moves it below the compact list.
  const [focused, setFocused] = useState<string>();
  const selected = typeof selection === "object" ? group.entries.find(entry =>
    entry.owner.id === selection.owner && (entry.name === selection.name || entry.owner.error)) : undefined;
  const selectedKey = selected ? selected.owner.id + "/" + (selected.name ?? "") : undefined;
  useEffect(() => { if (selectedKey) setOpen(true); }, [selectedKey]);
  const visible = expanded ? group.entries : group.entries.filter((entry, index) =>
    index < 5 || entry === selected || entry.owner.id + "/" + (entry.name ?? "") === focused,
  );
  return (
    <SidebarGroup className="project-navigation">
      <Collapsible open={open} onOpenChange={setOpen}>
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
            {visible.map(entry => {
              const label = entryLabel(entry, group);
              return (
                <SidebarMenuItem key={entry.owner.id + "/" + (entry.name ?? "")} className="preview-nav-row" data-active={entry === selected}
                  onFocusCapture={() => setFocused(entry.owner.id + "/" + (entry.name ?? ""))}>
                  <SidebarMenuButton className="preview-nav" isActive={entry === selected} aria-current={entry === selected ? "page" : undefined}
                    title={[entry.owner.project ?? entry.owner.id, entry.name].filter(Boolean).join(" · ")}
                    onClick={() => select({ owner: entry.owner.id, name: entry.name })}>
                    <span className="nav-name">{label.name}</span>
                    {label.qualifier && <span className="nav-detail">{label.qualifier}</span>}
                    <Status tone={entry.owner.error ? "error" : state(entry).tone}>
                      {entry.owner.error ? "Unavailable" : state(entry).label}
                    </Status>
                  </SidebarMenuButton>
                  <PreviewMenu entry={entry} mutate={mutate} acting={acting} />
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          {group.entries.length > 5 && <Button variant="ghost" className="project-more"
            onClick={() => { setExpanded(value => !value); setFocused(undefined); }}>
            {expanded ? "Show less" : `Show all ${group.entries.length}`}
          </Button>}
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
