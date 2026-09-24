import { Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./siteTheme.css";

const siteThemeStorageKey = "previewhost.docs.theme";

export type SiteTheme = "light" | "dark";

function normalizeSiteTheme(value: string | null): SiteTheme {
  return value === "dark" ? "dark" : "light";
}

function readDeviceSiteTheme(): SiteTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readStoredSiteTheme(): SiteTheme {
  try {
    const storedTheme = window.localStorage.getItem(siteThemeStorageKey);
    return storedTheme === null
      ? readDeviceSiteTheme()
      : normalizeSiteTheme(storedTheme);
  } catch {
    return readDeviceSiteTheme();
  }
}

function applySiteTheme(theme: SiteTheme) {
  document.documentElement.dataset.siteTheme = theme;
  const fallback = theme === "dark" ? "#000000" : "#ffffff";
  const themeColor =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--browser-theme-color")
      .trim() || fallback;

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor);
}

export function initializeSiteTheme(): SiteTheme {
  const theme = readStoredSiteTheme();
  applySiteTheme(theme);
  return theme;
}

export function useSiteTheme() {
  const [theme, setThemeState] = useState<SiteTheme>("light");

  const setTheme = useCallback((nextTheme: SiteTheme) => {
    applySiteTheme(nextTheme);
    try {
      window.localStorage.setItem(siteThemeStorageKey, nextTheme);
    } catch {
      // The selected theme still applies for this visit when storage is blocked.
    }
    setThemeState(nextTheme);
  }, []);

  useEffect(() => { setThemeState(initializeSiteTheme()); }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== siteThemeStorageKey) {
        return;
      }
      const nextTheme = normalizeSiteTheme(event.newValue);
      applySiteTheme(nextTheme);
      setThemeState(nextTheme);
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return {
    theme,
    toggleTheme: () =>
      setTheme(theme === "dark" ? "light" : "dark"),
  };
}

export function SiteThemeToggle({
  theme,
  onToggle,
  compact = false,
}: {
  theme: SiteTheme;
  onToggle: () => void;
  compact?: boolean;
}) {
  const isDark = theme === "dark";
  const classes = [
    "site-theme-toggle",
    compact ? "site-theme-toggle--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={classes}
      type="button"
      aria-label="Toggle color theme"
      aria-pressed={isDark}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={onToggle}
    >
      <span className="site-theme-toggle__icons" aria-hidden="true">
        <Sun
          className="site-theme-toggle__sun"
          data-visible={!isDark || undefined}
        />
        <Moon
          className="site-theme-toggle__moon"
          data-visible={isDark || undefined}
        />
      </span>
    </button>
  );
}
