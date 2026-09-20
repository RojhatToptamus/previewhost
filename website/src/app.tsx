import { ArrowLeft, ArrowRight, Check, ChevronRight, Code2, Command, Copy, ExternalLink as ExternalLinkGlyph, Menu, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SiteThemeToggle, type SiteTheme, useSiteTheme } from "./siteTheme";
import { pages, notFoundPage, type DocPage, type DocPageId, pageHref } from "./pages";
import "./styles.css";
import "./previewhost.css";

const GITHUB_URL = "https://github.com/RojhatToptamus/previewhost";

async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("Copy failed. Select the text and copy it manually.");
}

function MarkdownBody({ html }: { html: string }) {
  const [copyError, setCopyError] = useState("");
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  return <>
    {copyError && <p role="status">{copyError}</p>}
    <div className="docs-article-body" dangerouslySetInnerHTML={{ __html: html }} onClick={async (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy-code]");
      if (!button) return;
      const code = button.closest("figure")?.querySelector("code")?.textContent;
      if (code === undefined) return;
      try {
        await copyText(code);
        setCopyError("");
        const label = button.querySelector("span")!;
        label.textContent = "Copied";
        button.setAttribute("aria-label", "Code copied");
        const timer = setTimeout(() => {
          label.textContent = "Copy";
          button.setAttribute("aria-label", "Copy code");
          timers.current.delete(timer);
        }, 1800);
        timers.current.add(timer);
      } catch {
        setCopyError("Copy failed. Select the code and copy it manually.");
      }
    }} />
  </>;
}

type SearchEntry = {
  key: string;
  pageId: DocPageId;
  pageLabel: string;
  title: string;
  description: string;
  sectionId?: string;
  searchText: string;
};

const searchEntries: SearchEntry[] = pages.flatMap((page) => [
  {
    key: page.id,
    pageId: page.id,
    pageLabel: page.label,
    title: page.title,
    description: page.description,
    searchText: `${page.label} ${page.title} ${page.description}`.toLowerCase(),
  },
  ...page.sections.map((section) => ({
    key: `${page.id}:${section.id}`,
    pageId: page.id,
    pageLabel: page.label,
    title: section.title,
    description: section.summary,
    sectionId: section.id,
    searchText: `${page.label} ${section.title} ${section.summary} ${section.keywords ?? ""}`.toLowerCase(),
  })),
]);

const suggestedPageIds = ["welcome", "installation", "first-preview", "mcp", "configuration", "troubleshooting"];

function groupedPages() {
  const groups: Array<{ label: string; pages: DocPage[] }> = [];
  for (const page of pages) {
    const current = groups.at(-1);
    if (current?.label === page.group) {
      current.pages.push(page);
    } else {
      groups.push({ label: page.group, pages: [page] });
    }
  }
  return groups;
}

const navGroups = groupedPages();

function DocsHeader({
  onOpenSearch,
  onOpenMenu,
  menuOpen,
  theme,
  onToggleTheme,
}: {
  onOpenSearch: () => void;
  onOpenMenu: () => void;
  menuOpen: boolean;
  theme: SiteTheme;
  onToggleTheme: () => void;
}) {

  return (
    <header className="docs-header">
      <div className="docs-header-inner">
        <button
          className="docs-mobile-menu-button"
          type="button"
          onClick={onOpenMenu}
          aria-expanded={menuOpen}
          aria-controls="docs-sidebar"
          aria-label={menuOpen ? "Close documentation menu" : "Open documentation menu"}
        >
          {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
        <a className="docs-brand" href={pageHref("welcome")} aria-label="Previewhost documentation">
          <span className="docs-brand-mark">
            <img src={`${import.meta.env.BASE_URL}previewhost.svg`} alt="" />
          </span>
          <span className="docs-brand-name">Previewhost</span>
          <span className="docs-brand-divider" aria-hidden="true" />
          <span className="docs-brand-section">Docs</span>
        </a>

        <button
          className="docs-search-trigger"
          type="button"
          onClick={onOpenSearch}
          aria-label="Search documentation (Command or Control K)"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Search aria-hidden="true" />
          <span>Search documentation</span>
          <kbd>
            <Command aria-hidden="true" />
            K
          </kbd>
        </button>

        <div className="docs-header-actions">
          <nav className="docs-header-links" aria-label="Product links">
            <a href="https://www.npmjs.com/package/previewhost">npm</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Code2 aria-hidden="true" />
              <span>GitHub</span>
            </a>
          </nav>
          <SiteThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </header>
  );
}

function DocsSidebar({
  currentPageId,
  onNavigate,
  open,
  onClose,
}: {
  currentPageId: DocPageId;
  onNavigate: (pageId: DocPageId, sectionId?: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const [compact, setCompact] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const handleChange = (event: MediaQueryListEvent) => {
      setCompact(event.matches);
      if (!event.matches) {
        onCloseRef.current();
      }
    };
    setCompact(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!compact || !open) {
      return;
    }

    previousFocus.current = document.activeElement as HTMLElement | null;
    const background = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".docs-header, .docs-main, .docs-outline",
      ),
    );
    const focusable = sidebarRef.current
      ? Array.from(
          sidebarRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        )
      : [];
    const firstFocusable = focusable.at(0);
    const lastFocusable = focusable.at(-1);
    background.forEach((element) => {
      element.inert = true;
    });
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !firstFocusable || !lastFocusable) {
        return;
      }
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      background.forEach((element) => {
        element.inert = false;
      });
      previousFocus.current?.focus();
    };
  }, [compact, open]);

  return (
    <>
      <button
        className={`docs-drawer-backdrop ${open ? "is-open" : ""}`}
        type="button"
        aria-label="Close documentation menu"
        aria-hidden={!open}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
      />
      <aside
        id="docs-sidebar"
        ref={sidebarRef}
        className={`docs-sidebar ${open ? "is-open" : ""}`}
        aria-hidden={compact && !open}
        role={compact && open ? "dialog" : undefined}
        aria-modal={compact && open ? "true" : undefined}
        aria-label={compact && open ? "Documentation navigation" : undefined}
        inert={compact && !open ? true : undefined}
      >
        <div className="docs-sidebar-mobile-heading">
          <span>Documentation</span>
          <button type="button" onClick={onClose} aria-label="Close documentation menu">
            <X aria-hidden="true" />
          </button>
        </div>
        <nav className="docs-sidebar-nav" aria-label="Documentation">
          {navGroups.map((group) => (
            <div className="docs-nav-group" key={group.label}>
              <p className="docs-nav-group-label">{group.label}</p>
              <ul>
                {group.pages.map((page) => {
                  const current = page.id === currentPageId;
                  return (
                    <li key={page.id}>
                      <a
                        href={pageHref(page.id)}
                        className={current ? "is-active" : undefined}
                        aria-current={current ? "page" : undefined}
                        onClick={(event) => {
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          ) {
                            return;
                          }
                          event.preventDefault();
                          onNavigate(page.id);
                        }}
                      >
                        <span>{page.label}</span>
                        {current && <ChevronRight className="docs-nav-current" aria-hidden="true" />}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

function OnPageOutline({
  page,
  activeSection,
  onCopyPage,
  copied,
}: {
  page: DocPage;
  activeSection: string;
  onCopyPage: () => void;
  copied: boolean;
}) {
  return (
    <aside className="docs-outline" aria-label="On this page">
      <div className="docs-outline-inner">
        <p className="docs-outline-label">On this page</p>
        <ol>
          {page.sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className={activeSection === section.id ? "is-active" : undefined}
              >
                {section.title}
              </a>
            </li>
          ))}
        </ol>
        <div className="docs-outline-actions">
          <button type="button" onClick={onCopyPage}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Page copied" : "Copy page"}
          </button>
        </div>
      </div>
    </aside>
  );
}

function PageNavigation({
  currentIndex,
  onNavigate,
}: {
  currentIndex: number;
  onNavigate: (pageId: DocPageId) => void;
}) {
  const previous = pages[currentIndex - 1];
  const next = pages[currentIndex + 1];

  return (
    <nav className="docs-page-navigation" aria-label="Documentation pagination">
      {previous ? (
        <a
          className="docs-page-link docs-page-link--previous"
          href={pageHref(previous.id)}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            onNavigate(previous.id);
          }}
        >
          <ArrowLeft aria-hidden="true" />
          <span>
            <small>Previous</small>
            <strong>{previous.label}</strong>
          </span>
        </a>
      ) : (
        <span />
      )}
      {next && (
        <a
          className="docs-page-link docs-page-link--next"
          href={pageHref(next.id)}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            onNavigate(next.id);
          }}
        >
          <span>
            <small>Next</small>
            <strong>{next.label}</strong>
          </span>
          <ArrowRight aria-hidden="true" />
        </a>
      )}
    </nav>
  );
}

function SearchDialog({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (pageId: DocPageId, sectionId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restorePreviousFocus = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return searchEntries.filter(
        (entry) => !entry.sectionId && suggestedPageIds.includes(entry.pageId),
      );
    }

    const tokens = normalized.split(/\s+/);
    return searchEntries
      .filter((entry) => tokens.every((token) => entry.searchText.includes(token)))
      .sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(normalized) ? 1 : 0;
        const bStarts = b.title.toLowerCase().startsWith(normalized) ? 1 : 0;
        return bStarts - aStarts || Number(Boolean(a.sectionId)) - Number(Boolean(b.sectionId));
      })
      .slice(0, 10);
  }, [query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocus.current = document.activeElement as HTMLElement | null;
    restorePreviousFocus.current = true;
    const background = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".docs-app > .docs-header, .docs-app > .docs-shell",
      ),
    );
    background.forEach((element) => {
      element.inert = true;
    });
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      background.forEach((element) => {
        element.inert = false;
      });
      if (restorePreviousFocus.current) {
        previousFocus.current?.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    resultsRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, results]);

  if (!open) {
    return null;
  }

  const selectResult = (entry: SearchEntry) => {
    restorePreviousFocus.current = false;
    onNavigate(entry.pageId, entry.sectionId);
    setQuery("");
    setActiveIndex(0);
    onClose();
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (results.length ? (current + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        results.length ? (current - 1 + results.length) % results.length : 0,
      );
    } else if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      selectResult(results[activeIndex]);
    }
  };

  return (
    <div
      className="docs-search-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="docs-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docs-search-title"
      >
        <h2 id="docs-search-title" className="docs-visually-hidden">
          Search documentation
        </h2>
        <div className="docs-search-input-wrap">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search guides, concepts, and actions…"
            aria-label="Search documentation"
            aria-controls="docs-search-results"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-activedescendant={results[activeIndex] ? `search-${results[activeIndex].key}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
          <button type="button" onClick={onClose} aria-label="Close search">
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="docs-search-meta">
          <span>{query ? `${results.length} result${results.length === 1 ? "" : "s"}` : "Suggested pages"}</span>
          <span className="docs-search-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <span>to move</span>
            <kbd>↵</kbd>
            <span>to open</span>
          </span>
        </div>

        <div
          ref={resultsRef}
          id="docs-search-results"
          className="docs-search-results"
          role="listbox"
          aria-label="Search results"
        >
          {results.length ? (
            results.map((entry, index) => (
              <button
                id={`search-${entry.key}`}
                key={entry.key}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "is-active" : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(entry)}
              >
                <span className="docs-search-result-copy">
                  <span className="docs-search-result-path">
                    Docs <ChevronRight aria-hidden="true" /> {entry.pageLabel}
                  </span>
                  <strong>{entry.title}</strong>
                  <small>{entry.description}</small>
                </span>
                <ArrowRight className="docs-search-result-arrow" aria-hidden="true" />
              </button>
            ))
          ) : (
            <div className="docs-search-empty">
              <Search aria-hidden="true" />
              <strong>No documentation found</strong>
              <span>Try a feature, action, provider, or error state.</span>
            </div>
          )}
        </div>

        <div className="docs-search-footer">
          <span>Previewhost documentation</span>
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">
            Report an issue <ExternalLinkGlyph aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}

export function DocsApp({ initialPageId = "welcome", html }: { initialPageId?: DocPageId; html: string }) {
  const currentPageId = initialPageId;
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("");
  const [pageCopied, setPageCopied] = useState(false);
  const { theme, toggleTheme } = useSiteTheme();
  const articleRef = useRef<HTMLElement>(null);
  const copyResetTimer = useRef<number | null>(null);
  const currentPage = pages.find((page) => page.id === currentPageId) ?? notFoundPage;
  const currentIndex = pages.indexOf(currentPage);

  const navigate = (pageId: DocPageId, sectionId?: string) => {
    window.location.assign(pageHref(pageId, sectionId));
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileNavOpen(false);
        setSearchOpen(true);
      }
      if (event.key === "Escape" && mobileNavOpen && !searchOpen) {
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [mobileNavOpen, searchOpen]);

  useEffect(() => {
    if (!searchOpen && !mobileNavOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNavOpen, searchOpen]);

  useEffect(() => {
    document.title = `${currentPage.title} · Previewhost`;
    document.querySelector('meta[name="description"]')?.setAttribute("content", currentPage.description);
    setActiveSection(currentPage.sections[0]?.id ?? "");
    setPageCopied(false);

    const requestedHash = window.location.hash.slice(1);
    const scrollFrame = window.requestAnimationFrame(() => {
      if (requestedHash) {
        document.getElementById(requestedHash)?.scrollIntoView({ block: "start" });
      }
    });

    const headings = currentPage.sections
      .map((section) => document.getElementById(section.id))
      .filter((heading): heading is HTMLElement => Boolean(heading));

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: "-18% 0px -68% 0px", threshold: [0, 1] },
    );

    headings.forEach((heading) => observer.observe(heading));
    return () => {
      window.cancelAnimationFrame(scrollFrame);
      observer.disconnect();
    };
  }, [currentPage]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
    },
    [],
  );

  const handleCopyPage = async () => {
    if (!articleRef.current) {
      return;
    }
    try { await copyText(articleRef.current.innerText); }
    catch { window.alert("Copy failed. Select the page text and copy it manually."); return; }
    setPageCopied(true);
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = window.setTimeout(() => setPageCopied(false), 1800);
  };

  return (
    <div className="docs-app">
      <a className="docs-skip-link" href="#docs-content">
        Skip to content
      </a>
      <DocsHeader
        onOpenSearch={() => {
          setMobileNavOpen(false);
          setSearchOpen(true);
        }}
        onOpenMenu={() => setMobileNavOpen((open) => !open)}
        menuOpen={mobileNavOpen}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="docs-shell">
        <DocsSidebar
          currentPageId={currentPageId}
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          onNavigate={navigate}
        />

        <main className="docs-main">
          <article id="docs-content" className="docs-article" ref={articleRef} tabIndex={-1}>
            <header className="docs-article-header">
              <h1>{currentPage.title}</h1>
              <p>
                {currentPage.description}
              </p>
              <button className="docs-mobile-copy" type="button" onClick={handleCopyPage}>
                {pageCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {pageCopied ? "Page copied" : "Copy page"}
              </button>
            </header>

            <MarkdownBody key={currentPage.id} html={html} />

            <PageNavigation currentIndex={currentIndex} onNavigate={navigate} />

          </article>
        </main>

        <OnPageOutline
          page={currentPage}
          activeSection={activeSection}
          onCopyPage={handleCopyPage}
          copied={pageCopied}
        />
      </div>

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={navigate}
      />
    </div>
  );
}
