import type {
  AttemptSummary,
  PreviewStatus,
  SecretSetupSummary,
} from "../../../src/contracts";

import type { PreviewReviewSummary } from "../../../src/dashboard-workflows";
import type { ProjectGit } from "../../../src/dashboard-identity";

export type Owner = {
  reviews?: PreviewReviewSummary[];
  git?: ProjectGit;
  id: string;
  project?: string;
  previews?: PreviewStatus[];
  requests?: SecretSetupSummary[];
  offline?: boolean;
  configuration?: { file: string; error?: { message: string } };
  error?: { message: string };
};
export type Entry = { owner: Owner; name?: string; preview?: PreviewStatus };

export function needsCleanup(preview?: PreviewStatus) {
  return !!(
    preview?.cleanup?.length ||
    preview?.data?.cleanup ||
    [preview?.active, preview?.candidate, preview?.latest].some(
      (attempt) => attempt?.state === "cleanup-incomplete",
    )
  );
}
export function deletionNeedsRetry(p?: PreviewStatus) {
  return (
    p?.data?.cleanup?.operation === "remove-credential" &&
    !p.cleanup?.length &&
    !attempts(p).some((attempt) => attempt.state === "cleanup-incomplete")
  );
}
export function requests(entry: Entry) {
  return entry.owner.requests?.filter((r) => r.name === entry.name) ?? [];
}
export function pending(entry: Entry) {
  return requests(entry).filter(
    (r) => r.state === "pending" || r.state === "saving",
  );
}
export function state(entry: Entry) {
  const p = entry.preview;
  if (entry.owner.offline && !p)
    return { label: "Offline", tone: "muted", note: "" };
  if (needsCleanup(p))
    return {
      label: "Cleanup incomplete",
      tone: "error",
      note: "",
    };
  if (pending(entry).length)
    return {
      label: "Needs secrets",
      tone: "warning",
      note: p?.active ? "App still serving" : "Private setup requested",
    };
  if (p?.candidate || p?.busy)
    return {
      label: p.candidate ? "Starting" : "Working",
      tone: "neutral",
      note: p.active
        ? p.candidate
          ? "Previous attempt serving"
          : "App serving"
        : p.candidate
          ? "Startup checks in progress"
          : "",
    };
  if (p?.latest?.state === "failed")
    return {
      label: p.active ? "Update failed" : "Startup failed",
      tone: "error",
      note: p.active ? "Previous attempt serving" : "Not serving",
    };
  if (!p && entry.owner.configuration?.error)
    return {
      label: "Configuration error",
      tone: "error",
      note: "Fix the configuration before startup",
    };
  if (!p)
    return {
      label: "Not started",
      tone: "muted",
      note: requests(entry).at(-1)?.state === "canceled"
        ? "Private setup canceled"
        : "",
    };
  if (p?.active)
    return {
      label: "Ready",
      tone: "ready",
      note: entry.owner.configuration?.error
        ? "Configuration needs attention · app serving"
        : p.latest?.state === "canceled"
          ? "Update canceled · app serving"
          : "",
    };
  return {
    label: "Stopped",
    tone: "muted",
    note:
      p?.latest?.state === "canceled"
        ? "Startup canceled"
        : p?.data
          ? "Data retained"
          : "",
  };
}
function pathSegments(path?: string) {
  return path?.split(path.startsWith("/") ? "/" : /[\\/]/).filter(Boolean) ?? [];
}

export function shortProject(owner: Owner) {
  return pathSegments(owner.project).at(-1) ?? "Unavailable owner";
}
export type ProjectLabel = { name: string; qualifier: string };

/** Display labels only. Matching paths never merge owners or grant access. */
export function projectLabels(owners: Owner[]): Map<string, ProjectLabel> {
  const parts = owners.map(owner => pathSegments(owner.project));
  return new Map(owners.map((owner, index) => {
    const path = parts[index];
    if (!path.length) return [owner.id, { name: "Unverified project", qualifier: owner.id.slice(0, 12) }];
    let depth = 1;
    while (depth < path.length && parts.some((other, i) =>
      i !== index && other.slice(-depth).join("/") === path.slice(-depth).join("/"),
    )) depth++;
    return [owner.id, { name: path.at(-1)!, qualifier: path.slice(-depth, -1).join("/") }];
  }));
}

export type ProjectGroup = { id: string; label: ProjectLabel; directory?: string; entries: Entry[] };

/** Git common directories group linked worktrees; names and remotes never merge projects. */
export function projectGroups(owners: Owner[], list: Entry[] = owners.flatMap(entries)): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const owner of owners) {
    const id = owner.git?.commonDirectory ?? owner.id;
    if (groups.has(id)) continue;
    const common = pathSegments(owner.git?.commonDirectory);
    const directory = owner.git
      ? (common.at(-1) === ".git" ? owner.git.commonDirectory.slice(0, -5) : owner.git.commonDirectory)
      : owner.project;
    groups.set(id, { id, directory, label: { name: "", qualifier: "" }, entries: [] });
  }
  const labels = projectLabels([...groups.values()].map(group => ({ id: group.id, project: group.directory })));
  for (const group of groups.values()) group.label = labels.get(group.id)!;
  // Preserve active / attention / recent ordering, including the order of the groups.
  const ordered = new Map<string, ProjectGroup>();
  for (const entry of list) {
    const id = entry.owner.git?.commonDirectory ?? entry.owner.id;
    const group = groups.get(id)!;
    group.entries.push(entry);
    ordered.set(id, group);
  }
  return [...ordered.values()];
}

function sourceSubdirectory(owner: Owner) {
  if (!owner.git || !owner.project) return;
  const separator = owner.git.root.startsWith("/") ? "/" : "\\";
  return owner.project.startsWith(owner.git.root + separator)
    ? owner.project.slice(owner.git.root.length + 1) : undefined;
}

export function entryLabel(entry: Entry, group: ProjectGroup): ProjectLabel {
  const { owner, name } = entry;
  const multiple = entries(owner).length > 1;
  const branch = owner.git?.branch;
  const subdirectory = sourceSubdirectory(owner);
  const duplicate = branch && group.entries.some(other => other.owner.id !== owner.id &&
    other.owner.git?.branch === branch && sourceSubdirectory(other.owner) === subdirectory);
  const worktree = [branch, subdirectory].filter(Boolean).join(" / ");
  if (branch && !duplicate) {
    return { name: [worktree, multiple ? name : undefined].filter(Boolean).join(" · "), qualifier: "" };
  }
  const owners = [...new Map(group.entries.map(item => [item.owner.id, item.owner])).values()];
  const folder = projectLabels(owners).get(owner.id)!;
  const path = [folder.qualifier, folder.name].filter(Boolean).join("/");
  return {
    name: branch ? [worktree, multiple ? name : undefined].filter(Boolean).join(" · ")
      : owner.git ? [`${path} (folder)`, multiple ? name : undefined].filter(Boolean).join(" · ") : name ?? folder.name,
    qualifier: duplicate ? path : "",
  };
}

export function lastAttempt(entry: Entry) {
  return entry.preview?.candidate ?? entry.preview?.latest ?? entry.preview?.active;
}

export function entries(owner: Owner): Entry[] {
  const names = [
    ...new Set([
      ...(owner.previews?.map((p) => p.name) ?? []),
      ...(owner.requests?.map((r) => r.name) ?? []),
      ...(owner.reviews?.map((review) => review.name) ?? []),
    ]),
  ];
  return names.length
    ? names.map((name) => ({
        owner,
        name,
        preview: owner.previews?.find((p) => p.name === name),
      }))
    : [{ owner }];
}

export function attempts(p?: PreviewStatus) {
  return [p?.candidate, p?.latest, p?.active].filter(
    (a, i, all): a is AttemptSummary =>
      !!a && all.findIndex((other) => other?.id === a.id) === i,
  );
}

export function hint(entry: Entry) {
  if (entry.owner.error) return "";
  const p = entry.preview;
  if (entry.owner.offline)
    return p?.data
      ? "Data retained. Start through your agent or CLI to run this preview again."
      : "";
  if (deletionNeedsRetry(p))
    return "Resolve the keystore error, then review data deletion again.";
  if (needsCleanup(p))
    return "Cleanup is incomplete; keep the source directories and retry cleanup before starting again.";
  if (pending(entry).length) return "Saving secrets does not start the app.";
  if (p?.candidate)
    return p.active ? "Your previous app is still running." : "";
  if (p?.busy) return "";
  if (p?.active && p.latest && ["failed", "canceled"].includes(p.latest.state))
    return "Your previous app is still running. Source edits and database writes are not rolled back.";
  if (p?.active) return "";
  if (p?.latest?.state === "failed")
    return "Fix the startup error, then retry.";
  if (p?.latest?.state === "canceled")
    return "Start preview uses the same configuration and current source.";
  if (!p)
    return "Review the configuration before starting. Saving secrets does not start the app.";
  return p?.data
    ? "Start again uses the same configuration, current source and retained database; it does not reload YAML."
    : "Start again uses the same configuration and current source without reloading YAML; the URL may change.";
}

export type PreviewFilter = "all" | "active" | "attention" | "inactive";
export function needsAttention(entry: Entry) {
  return !!(
    entry.owner.error ||
    entry.owner.configuration?.error ||
    ["error", "warning"].includes(state(entry).tone)
  );
}
export function isActive(entry: Entry) {
  return !!(
    entry.preview?.active ||
    entry.preview?.candidate ||
    entry.preview?.busy
  );
}
export function visibleEntries(
  owners: Owner[],
  query: string,
  filter: PreviewFilter,
): Entry[] {
  const search = query.trim().toLowerCase();
  const rank = (entry: Entry) =>
    isActive(entry) ? 0 : needsAttention(entry) ? 1 : 2;
  return owners
    .flatMap(entries)
    .filter((entry) => {
      const sources = [
        ...attempts(entry.preview).flatMap(attempt => attempt.sources),
        ...(entry.preview?.cleanup?.flatMap(item => item.sources) ?? []),
      ];
      const searchable = [entry.owner.project ?? entry.owner.id, entry.owner.git?.branch, entry.owner.git?.commonDirectory, entry.name, ...sources].join(" ");
      return searchable.toLowerCase().includes(search) &&
        (filter === "all" ||
          (filter === "active" && isActive(entry)) ||
          (filter === "attention" && needsAttention(entry)) ||
          (filter === "inactive" &&
            !entry.owner.error &&
            (!entry.owner.offline || !!entry.preview) &&
            !isActive(entry) &&
            !pending(entry).length &&
            !needsCleanup(entry.preview) &&
            !entry.preview?.url &&
            !entry.preview?.data?.running));
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (lastAttempt(b)?.startedAt ?? "").localeCompare(lastAttempt(a)?.startedAt ?? "") ||
        (a.owner.project ?? a.owner.id).localeCompare(
          b.owner.project ?? b.owner.id,
        ) ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    );
}

export const bindingLabels: Record<string, string> = {
  literal: "Value",
  secret: "Secret",
  fromEnv: "Runtime input",
  service: "Service URL",
  publicUrl: "Application URL",
  browserUrl: "Browser URL",
};
