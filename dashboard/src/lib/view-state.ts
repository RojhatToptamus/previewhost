import { useEffect, useState } from "react";

export type Selection = { owner: string; name?: string } | "secrets" | undefined;
export type PreviewView = {
  tab: "activity" | "logs" | "configuration";
  attemptId?: string;
  source: string;
  query: string;
  wrapLogs: boolean;
  showContext: boolean;
  clearAfter?: number;
};

function selectionFromHistory(): Selection {
  const value = history.state?.previewhost;
  if (value === "secrets") return value;
  if (
    value && /^[a-f0-9]{64}$/.test(value.owner) &&
    (value.name === undefined || typeof value.name === "string")
  ) {
    return { owner: value.owner, name: value.name };
  }
}

export function useSelection() {
  const [selection, setSelection] = useState(selectionFromHistory);
  useEffect(() => {
    const restore = () => setSelection(selectionFromHistory());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  function select(value: Selection) {
    if (JSON.stringify(value) === JSON.stringify(selection)) return;
    history.pushState({ previewhost: value }, "", "/");
    setSelection(value);
  }
  return [selection, select] as const;
}

// Only presentation choices belong here. Runtime data and authorization stay in the API.
export function usePreviewView(owner: string, name?: string) {
  const key = `previewhost.view/${owner}/${name ?? ""}`;
  const [view, setView] = useState<PreviewView>(() => {
    let saved: Partial<PreviewView> = {};
    try {
      saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") ?? {};
    } catch {
      /* A fresh view still works when storage is unavailable. */
    }
    const attemptId = typeof saved.attemptId === "string" ? saved.attemptId : undefined;
    return {
      tab: saved.tab === "logs" || saved.tab === "configuration" ? saved.tab : "activity",
      attemptId,
      source: typeof saved.source === "string" ? saved.source : "",
      query: typeof saved.query === "string" ? saved.query : "",
      wrapLogs: saved.wrapLogs === true,
      showContext: saved.showContext === true,
      clearAfter: attemptId && Number.isSafeInteger(saved.clearAfter) && saved.clearAfter! >= 0
        ? saved.clearAfter : undefined,
    };
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(view));
    } catch {
      /* Navigation remains usable without browser storage. */
    }
  }, [key, view]);
  const update = (patch: Partial<PreviewView>) => setView(current => ({ ...current, ...patch }));
  return [view, update] as const;
}
