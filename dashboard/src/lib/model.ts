import type {
  AttemptSummary,
  PreviewStatus,
  SecretSetupSummary,
} from "../../../src/contracts";

export type Owner = {
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
      note: "Fix preview.yml before startup",
    };
  if (!p)
    return {
      label: "Not started",
      tone: "muted",
      note: requests(entry).some((r) => r.state === "canceled")
        ? "Private setup canceled"
        : "",
    };
  if (p?.active)
    return {
      label: "Ready",
      tone: "ready",
      note: entry.owner.configuration?.error
        ? "preview.yml needs attention · app serving"
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
export function shortProject(owner: Owner) {
  return (
    owner.project?.split("/").filter(Boolean).at(-1) ?? "Unavailable owner"
  );
}
export function entries(owner: Owner): Entry[] {
  const names = [
    ...new Set([
      ...(owner.previews?.map((p) => p.name) ?? []),
      ...(owner.requests?.map((r) => r.name) ?? []),
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
  const p = entry.preview;
  if (entry.owner.offline)
    return p?.data
      ? "Data retained. Start through your agent or CLI to run this preview again."
      : "";
  if (deletionNeedsRetry(p))
    return "Resolve the Keychain error, then retry data deletion.";
  if (needsCleanup(p))
    return "Cleanup is incomplete; keep the source directories and retry cleanup before starting again.";
  if (pending(entry).length) return "Saving secrets does not start the app.";
  if (p?.candidate)
    return p.active ? "Your previous app is still running." : "";
  if (p?.busy) return "";
  if (p?.active && p.latest?.state === "failed")
    return "Your previous app is still running.";
  if (p?.active) return "";
  if (p?.latest?.state === "failed")
    return "Fix the startup error, then retry.";
  if (p?.latest?.state === "canceled")
    return "Startup was canceled; ask your agent to start again only when you want to continue.";
  if (!p)
    return "Ask your agent to continue when setup is complete and you want to start this worktree.";
  return p?.data
    ? "Start again uses the same configuration, current source and retained database; it does not reload YAML."
    : "Start again uses the same configuration and current source without reloading YAML; the URL may change.";
}

export type PreviewFilter = "all" | "active" | "attention" | "stopped";
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
    .filter(
      (entry) =>
        `${entry.owner.project ?? ""} ${entry.name ?? ""}`
          .toLowerCase()
          .includes(search) &&
        (filter === "all" ||
          (filter === "active" && isActive(entry)) ||
          (filter === "attention" && needsAttention(entry)) ||
          (filter === "stopped" &&
            !entry.owner.error &&
            !isActive(entry) &&
            !pending(entry).length &&
            !needsCleanup(entry.preview))),
    )
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.owner.project ?? a.owner.id).localeCompare(
          b.owner.project ?? b.owner.id,
        ) ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    );
}
