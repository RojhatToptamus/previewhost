import { LayoutGridIcon, KeyRoundIcon } from "lucide-react";
import type { Mutate } from "./lib/api";
import { entries, previewDetail, state, type Entry, type ProjectLabel } from "./lib/model";
import type { Selection } from "./lib/view-state";
import {
  Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarGroupLabel,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, useSidebar,
} from "./components/ui/sidebar";
import { Status } from "./components/shared";
import { PreviewMenu } from "./preview-actions";

export function Navigation({ recent, labels, selection, select, mutate, acting }: {
  recent: Entry[];
  labels: Map<string, ProjectLabel>;
  selection: Selection;
  select(value: Selection): void;
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
      <SidebarContent aria-label="Recent previews">
        {!!recent.length && <SidebarGroup>
          <SidebarGroupLabel>Recent previews</SidebarGroupLabel>
          <SidebarMenu>
            {recent.map(entry => {
              const label = labels.get(entry.owner.id)!;
              const selected = typeof selection === "object" &&
                selection.owner === entry.owner.id && selection.name === entry.name;
              const detail = previewDetail(entry, label);
              const previews = entry.name === undefined && !entry.owner.error
                ? entries(entry.owner).filter(item => item.name !== undefined).length : 0;
              return (
                <SidebarMenuItem key={entry.owner.id + "/" + (entry.name ?? "")} className="preview-nav-row" data-active={selected}>
                  <SidebarMenuButton className="preview-nav" isActive={selected}
                    title={[entry.owner.project ?? entry.owner.id, entry.name].filter(Boolean).join(" · ")}
                    onClick={() => navigate({ owner: entry.owner.id, name: entry.name })}>
                    <span className="nav-name">{label.name}</span>
                    {detail && <span className="nav-detail">{detail}</span>}
                    <Status tone={entry.owner.error ? "error" : state(entry).tone}>
                      {entry.owner.error ? "Unavailable" : previews ? `${previews} ${previews === 1 ? "preview" : "previews"}` : state(entry).label}
                    </Status>
                  </SidebarMenuButton>
                  <PreviewMenu entry={entry} mutate={mutate} acting={acting} />
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>}
      </SidebarContent>
    </Sidebar>
  );
}
