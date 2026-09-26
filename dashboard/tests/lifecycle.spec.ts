import { test, expect, type Locator, type Route } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AttemptSummary, PreviewStatus } from "../../src/contracts";
import { visibleEntries, type Owner } from "../src/lib/model";
const { createPreviewRuntime } = (await import(
  new URL("../../dist/runtime.js", import.meta.url).href
)) as typeof import("../../src/runtime");
const { startDaemon } = (await import(
  new URL("../../dist/daemon.js", import.meta.url).href
)) as typeof import("../../src/daemon");
const { startDashboard } = (await import(
  new URL("../../dist/dashboard.js", import.meta.url).href
)) as typeof import("../../src/dashboard");
const { createDataOwner } = (await import(
  new URL("../../dist/data.js", import.meta.url).href
)) as typeof import("../../src/data");

test("preview filters keep uncertain owners and running resources out of Inactive", () => {
  const attempt = (state: AttemptSummary["state"]): AttemptSummary => ({
    id: state, type: "static", state, startedAt: "2026-09-25T10:00:00Z", sources: [],
  });
  const owner = (id: string, preview: Partial<PreviewStatus> = {}): Owner => ({
    id, project: `/work/${id}`, previews: [{ name: "app", busy: false, ...preview }],
  });
  const owners: Owner[] = [
    owner("serving", { active: attempt("ready") }),
    owner("failed-update", { active: attempt("ready"), latest: attempt("failed") }),
    owner("starting", { candidate: attempt("starting") }),
    owner("stopped", { latest: attempt("stopped") }),
    owner("failed-start", { latest: attempt("failed") }),
    owner("canceled", { latest: attempt("canceled") }),
    { id: "not-started", project: "/work/not-started" },
    { ...owner("unavailable"), error: { message: "Owner did not respond" } },
    { id: "offline", project: "/work/offline", offline: true },
    owner("cleanup", { latest: attempt("cleanup-incomplete") }),
    owner("running-data", { data: { resources: [{ name: "db", type: "postgres" }], running: true } }),
    { ...owner("retained-data", { data: { resources: [{ name: "db", type: "postgres" }], running: false } }), offline: true },
  ];
  const ids = (filter: Parameters<typeof visibleEntries>[2]) => visibleEntries(owners, "", filter).map(entry => entry.owner.id).sort();
  expect(ids("active")).toEqual(["failed-update", "serving", "starting"]);
  expect(ids("attention")).toEqual(["cleanup", "failed-start", "failed-update", "unavailable"]);
  expect(ids("inactive")).toEqual(["canceled", "failed-start", "not-started", "retained-data", "stopped"]);
  expect(visibleEntries(owners, "failed", "inactive").map(entry => entry.owner.id)).toEqual(["failed-start"]);
});

test("linked worktrees stay grouped, discoverable and independently controllable", async ({ page, browser }) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "previewhost-navigation-")));
  const evidence = "/private/tmp/previewhost-navigation-review";
  await mkdir(evidence, { recursive: true });
  const fixtures: Array<{
    id: string;
    project: string;
    name: string;
    tokenFile: string;
    closed: boolean;
    unavailable?: boolean;
    retained?: { projectDirectory: string; dataDirectory: string };
    daemon: Awaited<ReturnType<typeof startDaemon>>;
    runtime: Awaited<ReturnType<typeof createPreviewRuntime>>;
  }> = [];
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let visible = 1;
  let releaseSecond = () => {};
  let releaseThird = () => {};
  let releaseLists = () => {};
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test",
      "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" });
    const repositories = ["projects/atlas", "projects/internal/ledger-api", "repositories/customer-portal", "projects/design/studio"];
    for (const repository of repositories) {
      const root = join(directory, repository);
      await mkdir(root, { recursive: true });
      git(root, "init", "-b", "main");
      git(root, "commit", "--allow-empty", "-m", "Disposable fixture");
    }
    const named = [
      ["projects/atlas/web", "web"],
      ["worktrees/checkout-layout/atlas-web", "review"],
      ["worktrees/feature-pricing/atlas-web", "web"],
      ["projects/internal/ledger-api", "api"],
      ["worktrees/chart-legend/ledger-api", "api"],
      ["scratch/receipt-checker", "preview"],
      ["projects/archive/customer-portal", "portal"],
      ["worktrees/header-search/customer-portal", "portal"],
      ["worktrees/editor-toolbar/studio", "editor"],
      ["projects/design/studio", "catalog"],
    ];
    for (let i = 0; i < 100; i++) {
      const [relative, name] = named[i] ?? [
        `worktrees/${["account-settings", "checkout-flow", "invoice-list", "onboarding"][i % 4]}-${i}/${["atlas-web", "ledger-api", "customer-portal", "studio"][i % 4]}`,
        ["web", "api", "portal", "editor"][i % 4],
      ];
      const project = join(directory, relative);
      if (i !== 0 && i !== 3 && i !== 5 && i !== 9) {
        const repository = i === 1 || i === 2 ? 0 : i === 4 ? 1 : i === 6 || i === 7 ? 2 : i === 8 ? 3 : i % 4;
        const branch = relative.split("/")[1];
        git(join(directory, repositories[repository]), "worktree", "add", "-b", branch, project);
      }
      await mkdir(project, { recursive: true });
      if (i === 4) git(project, "checkout", "--detach");
      if (i === 10 || i === 14) git(project, "checkout", "--ignore-other-worktrees", "main");
      if (i === 8) git(project, "branch", "-m", "feature/editor-toolbar-with-keyboard-navigation-and-long-labels");
      await writeFile(join(project, "index.html"), `<h1>${name} ${i}</h1>`);
      const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
      if (i === 0) {
        const backend = join(directory, "projects/atlas/api");
        await mkdir(backend, { recursive: true });
        await writeFile(join(backend, "index.html"), "API");
        const start = await runtime.start({ name, type: "environment", primary: "web", services: {
          web: { type: "static", directory: project }, api: { type: "static", directory: backend },
        } });
        await runtime.wait(name, start.candidate!.id);
      } else {
        const start = await runtime.start({ name, type: "static", directory: i === 3 ? join(project, "missing") : project });
        await runtime.wait(name, start.candidate!.id);
        if (i > 1 && i !== 3) await runtime.stop(name);
      }
      const tokenFile = join(directory, "owners", String(i), "token");
      const daemon = await startDaemon({ runtime, tokenFile, port: 0, owner: {
        projectDirectory: project, pid: process.pid, allowedRoots: [directory], allowExec: false, inputKeys: [], secretIds: [],
      } });
      const id = createHash("sha256").update(project).digest("hex");
      const fixture: (typeof fixtures)[number] = { id, project, name, runtime, daemon, tokenFile, closed: false };
      fixtures.push(fixture);
      void daemon.closed.then(() => { fixture.closed = true; });
      if (i === 6) {
        const dataDirectory = join(directory, "offline-data");
        const data = await createDataOwner({ directory: dataDirectory });
        await data.close();
        await daemon.close();
        fixture.retained = { projectDirectory: project, dataDirectory };
        await rm(project, { recursive: true });
      }
      if (i === 7) { fixture.unavailable = true; await daemon.close(); }
    }
    let launch = "";
    dashboard = await startDashboard({
      discover: async () => fixtures.slice(0, visible)
        .filter(f => !f.closed || f.retained || f.unavailable)
        .map(f => ({ id: f.id, tokenFile: f.tokenFile, ...(f.retained
          ? { retained: f.retained }
          : { connection: { endpoint: f.daemon.endpoint, pid: process.pid, projectDirectory: f.project } }) })),
      openBrowser: async url => { launch = url; },
    });
    await dashboard.open();
    const sorted = [...fixtures].sort((a, b) => a.id.localeCompare(b.id));
    const secondPage = new Promise<void>(resolve => { releaseSecond = resolve; });
    const thirdPage = new Promise<void>(resolve => { releaseThird = resolve; });
    let holdPages = false;
    let listGate: Promise<void> | undefined;
    let rejectRecheck = false;
    // UI preference behavior is isolated here; durable storage has its own integration test.
    let pinnedProjects: string[] = [];
    let rejectPreferenceSave = false;
    async function navigationPreferences(route: Route) {
      const input = route.request().postDataJSON();
      if (input.action === "saveNavigationPreferences") {
        if (rejectPreferenceSave) return route.fulfill({ json: { error: { code: "INVALID_INPUT", message: "Fixture preferences cannot be saved." } } });
        pinnedProjects = input.pinnedProjects;
      } else if (input.action !== "navigationPreferences") return route.continue();
      await route.fulfill({ json: { result: { pinnedProjects } } });
    }
    await page.context().route("**/api", navigationPreferences);
    await page.route("**/api", async route => {
      const input = route.request().postDataJSON();
      if (input.action === "list") {
        if (holdPages && input.after === sorted[15].id) await secondPage;
        if (holdPages && input.after === sorted[31].id) await thirdPage;
        if (listGate) await listGate;
      }
      if (input.action === "recheck" && rejectRecheck) {
        await route.fulfill({ json: { error: { code: "TIMEOUT", message: "Fixture owner did not respond." } } });
      } else await route.fallback();
    });
    const tableRows = page.locator(".overview-table tbody tr");
    const nav = page.locator('[data-slot="sidebar-content"]');
    const rowFor = (scope: Locator, index: number) => scope.filter({ has: page.locator(
      `[title=${JSON.stringify(fixtures[index].project)}], [title^=${JSON.stringify(fixtures[index].project + " · ")}]`,
    ) });
    const navigationRow = (index: number) => rowFor(nav.locator(".preview-nav-row"), index);
    const overview = async () => {
      const button = page.getByRole("button", { name: "Overview", exact: true });
      if (!await button.isVisible()) await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await button.click();
    };
    const search = page.getByRole("searchbox", { name: "Search previews" });
    async function filterBy(name: string) {
      await page.getByRole("tab", { name, exact: true }).click();
    }
    async function action(row: Locator, name: string) {
      await row.getByRole("button", { name: /^Actions for/ }).click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    }
    async function capture(count: number) {
      await expect(page.getByRole("status", { name: "Loading remaining previews" })).toHaveCount(0);
      const notifications = page.locator("[data-sonner-toast]");
      while (await notifications.count()) {
        const remaining = await notifications.count();
        await notifications.first().getByRole("button", { name: "Close toast" }).click();
        await expect.poll(() => notifications.count()).toBeLessThan(remaining);
      }
      await page.screenshot({ path: join(evidence, `after-${count}-light.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Dark mode", exact: true }).click();
      await page.screenshot({ path: join(evidence, `after-${count}-dark.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    }
    await page.goto(launch);
    await expect(tableRows).toHaveCount(1);
    await capture(1);
    visible = 10;
    await expect(tableRows).toHaveCount(10);
    await expect(nav.locator(".preview-nav")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Dashboard", exact: true }).getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(rowFor(tableRows, 1)).toContainText("checkout-layout");
    await expect(rowFor(tableRows, 2)).toContainText("feature-pricing");
    await search.fill("receipt-checker");
    await filterBy("Needs attention");
    await expect(search).toHaveValue("receipt-checker");
    await expect(tableRows).toHaveCount(0);
    await search.fill("");
    await expect(tableRows).toHaveCount(2);
    await filterBy("Inactive");
    await expect(tableRows).toHaveCount(6);
    await filterBy("All");
    await search.fill("scratch");
    await expect(tableRows).toHaveCount(1);
    await expect(tableRows).toContainText("receipt-checker");
    await search.fill("projects/atlas/api");
    await expect(tableRows).toHaveCount(1);
    await expect(rowFor(tableRows, 0)).toBeVisible();
    await search.fill("");
    // Shared sidebar geometry and selected typography stay stable.
    const dashboardNav = page.getByRole("navigation", { name: "Dashboard", exact: true });
    const iconCenters = await page.locator('[data-slot="sidebar-menu-button"] > svg, .project-toggle > svg').evaluateAll(icons => icons.map(icon => {
      const box = icon.getBoundingClientRect();
      return box.x + box.width / 2;
    }));
    expect(Math.max(...iconCenters) - Math.min(...iconCenters)).toBeLessThan(1);
    const overviewButton = dashboardNav.getByRole("button", { name: "Overview", exact: true });
    const selectedWeight = await overviewButton.evaluate(element => getComputedStyle(element).fontWeight);
    await dashboardNav.getByRole("button", { name: "Secret Manager", exact: true }).click();
    expect(await overviewButton.evaluate(element => getComputedStyle(element).fontWeight)).toBe(selectedWeight);
    await overview();
    await capture(10);
    const projectOptions = (name: string) => nav.getByRole("button", { name: `Project options for ${name}`, exact: true });
    async function organize(name: string, action: string) {
      await expect(projectOptions(name)).toBeEnabled();
      await projectOptions(name).focus();
      await page.keyboard.press("Enter");
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith("/api") && response.request().postDataJSON().action === "saveNavigationPreferences"),
        page.getByRole("menuitem", { name: action, exact: true }).press("Enter"),
      ]);
      await expect(projectOptions(name)).toBeEnabled();
    }
    await organize("atlas", "Pin project");
    await expect(nav.locator(".project-toggle:visible")).toHaveCount(6);
    await expect(projectOptions("atlas")).toBeFocused();
    await expect(nav.locator(".navigation-label")).toHaveText(["Pinned", "Projects"]);
    await organize("ledger-api", "Pin project");
    await organize("ledger-api", "Move up");
    await expect(projectOptions("ledger-api")).toBeFocused();
    await expect(nav.locator(".project-toggle:visible").first()).toHaveAccessibleName("ledger-api");
    rejectPreferenceSave = true;
    await organize("ledger-api", "Move down");
    await expect(nav.getByRole("alert")).toContainText("Fixture preferences cannot be saved.");
    await expect(nav.locator(".project-toggle:visible").first()).toHaveAccessibleName("ledger-api");
    rejectPreferenceSave = false;
    await organize("ledger-api", "Move down");
    await expect(nav.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(tableRows).toHaveCount(10);
    await expect(nav.locator(".project-toggle:visible")).toHaveCount(6);
    await expect(nav.locator(".project-toggle:visible").first()).toHaveAccessibleName("atlas");
    await organize("ledger-api", "Unpin project");
    await organize("atlas", "Unpin project");
    await expect(nav.locator(".project-toggle:visible")).toHaveCount(6);
    await expect(projectOptions("atlas")).toBeFocused();
    await expect(nav.locator(".navigation-label")).toHaveText(["Projects"]);
    // A failed non-command service keeps a focused log action on its own row.
    await rowFor(tableRows, 3).locator(".overview-status").click();
    await page.locator(".service-table tr").filter({ hasText: "api" }).getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Log source" })).toHaveText("api");
    await expect(page.getByRole("combobox", { name: "Diagnostic attempt" })).toContainText((await fixtures[3].runtime.get("api")).latest!.id.slice(0, 8));
    await overview();
    visible = 100;
    holdPages = true;
    await page.reload();
    await expect(tableRows).toHaveCount(16);
    releaseSecond();
    await expect(tableRows).toHaveCount(32);
    await expect(page.getByRole("status", { name: "Loading remaining previews" })).toBeVisible();
    releaseThird();
    await expect(tableRows).toHaveCount(100);
    holdPages = false;
    await expect(nav.getByRole("searchbox")).toHaveCount(0);
    await expect(nav.getByRole("combobox")).toHaveCount(0);
    const qualifier = await rowFor(tableRows, 10).locator(".overview-worktree").textContent();
    expect(qualifier).toBeTruthy();
    await search.fill("invoice-list-10");
    await expect(tableRows).toHaveCount(1);
    await expect(rowFor(tableRows, 10).locator(".overview-worktree")).toHaveText(qualifier!);
    await search.fill("");
    // Keyboard selection opens the exact worktree without changing project identity.
    await rowFor(tableRows, 0).locator(".preview-name").focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("article", { name: "Preview details" });
    await expect(details).toContainText("projects/atlas/web");
    await expect(navigationRow(0)).toBeVisible();
    // Tab changes preserve the user's workspace position, even on a notebook.
    await page.setViewportSize({ width: 1280, height: 720 });
    const workspace = page.locator(".main-workspace");
    const tabs = page.getByRole("tablist", { name: "Preview diagnostics" });
    const geometry = () => tabs.getByRole("tab").evaluateAll(elements => elements.map(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, weight: getComputedStyle(element).fontWeight };
    }));
    for (const position of [0, 100]) {
      await workspace.evaluate((element, top) => { element.scrollTop = top; }, position);
      const before = await geometry();
      for (const name of ["Logs", "Configuration", "Activity"]) {
        await tabs.getByRole("tab", { name, exact: true }).click();
        await expect(page.getByRole("tabpanel").filter({ visible: true })).toBeVisible();
        expect(await workspace.evaluate(element => element.scrollTop)).toBe(position);
        expect(await geometry()).toEqual(before);
      }
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await overview();
    await search.fill("checkout-layout");
    await rowFor(tableRows, 1).locator(".overview-status").click();
    await expect(details).toContainText("checkout-layout");
    const atlas = nav.locator(".project-navigation").filter({ has: page.getByRole("button", { name: "atlas", exact: true }) });
    await expect(navigationRow(0)).toBeVisible();
    await expect(navigationRow(1)).toBeVisible();
    const orderBeforeStop = await atlas.locator(".nav-name").allTextContents();
    listGate = new Promise<void>(resolve => { releaseLists = resolve; });
    // Sidebar actions operate on their row without leaving the selected environment.
    const stoppedRow = await fixtures[0].runtime.stop(fixtures[0].name);
    await action(navigationRow(0), "Recheck status");
    await expect(navigationRow(0).locator(".preview-nav")).toHaveAccessibleName(/Stopped$/);
    expect(await atlas.locator(".nav-name").allTextContents()).toEqual(orderBeforeStop);
    await expect(details).toContainText("checkout-layout");
    const resumedRow = await fixtures[0].runtime.startAgain(fixtures[0].name, stoppedRow.latest!.id);
    await fixtures[0].runtime.wait(fixtures[0].name, resumedRow.candidate!.id);
    await action(navigationRow(0), "Recheck status");
    await expect(navigationRow(0).locator(".preview-nav")).toHaveAccessibleName(/Ready$/);
    rejectRecheck = true;
    await action(navigationRow(1), "Recheck status");
    await expect(details.locator(".preview-title")).toContainText("Unavailable");
    await expect(details.getByRole("link", { name: "Open app", exact: true })).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const stoppedNeighbor = await fixtures[1].runtime.stop(fixtures[1].name);
    rejectRecheck = false;
    await action(navigationRow(1), "Recheck status");
    await expect(details.locator(".preview-title")).toContainText("Stopped");
    const restartedNeighbor = await fixtures[1].runtime.startAgain(fixtures[1].name, stoppedNeighbor.latest!.id);
    await fixtures[1].runtime.wait(fixtures[1].name, restartedNeighbor.candidate!.id);
    listGate = undefined; releaseLists();
    await expect(details.locator(".preview-title")).toContainText("Ready");
    const neighborUrl = (await fixtures[1].runtime.get(fixtures[1].name)).url!;
    await overview();
    await expect(search).toHaveValue("checkout-layout");
    await search.fill("");
    // Expanded projects keep rows mounted; selection reveals them in the sidebar.
    expect(await atlas.locator(".preview-nav").count()).toBeGreaterThan(20);
    const toggle = atlas.getByRole("button", { name: "atlas", exact: true });
    await toggle.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    expect(await toggle.evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    })).toBe(true);
    await page.keyboard.press("Space");
    await expect(atlas.locator(".preview-nav")).toHaveCount(0);
    await rowFor(tableRows, 0).locator(".preview-name").click();
    await expect(navigationRow(0)).toBeVisible();
    await expect(navigationRow(0)).toBeInViewport();
    const groupScroll = nav;
    expect(await groupScroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await overview();
    expect(await atlas.locator(".preview-nav").count()).toBeGreaterThan(20);
    const beforeRefresh = await groupScroll.evaluate(element => element.scrollTop);
    await page.waitForResponse(response => response.url().endsWith("/api") && response.request().postDataJSON()?.action === "list");
    await expect.poll(() => groupScroll.evaluate(element => element.scrollTop)).toBe(beforeRefresh);
    await expect(tableRows).toHaveCount(100);
    // Renaming a source during an open menu reorders rows without discarding the interaction.
    await navigationRow(0).getByRole("button", { name: /^Actions for/ }).click();
    git(join(directory, repositories[0]), "branch", "-m", "main", "aaa-current-work");
    await expect(navigationRow(0)).toContainText("aaa-current-work");
    await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(navigationRow(0).getByRole("button", { name: /^Actions for/ })).toBeFocused();
    git(join(directory, repositories[0]), "branch", "-m", "aaa-current-work", "main");
    await expect(navigationRow(0)).toContainText("main / web");
    await capture(100);
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 560 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    try {
      await touchContext.route("**/api", navigationPreferences);
      const touch = await touchContext.newPage();
      await touch.goto(launch);
      await expect(touch.locator(".overview-table .preview-name")).toHaveCount(100);
      await touch.locator(".overview-table .preview-name").filter({ hasText: "checkout-layout" }).tap();
      await touch.getByRole("button", { name: "Toggle Sidebar" }).tap();
      const drawer = touch.getByRole("dialog");
      const target = drawer.locator(".preview-nav-row").filter({ hasText: "checkout-layout" });
      await expect(target).toBeInViewport();
      await target.getByRole("button", { name: /^Actions for/ }).tap();
      await touch.getByRole("menuitem", { name: "Recheck status", exact: true }).tap();
      await expect(drawer).toBeVisible();
      await target.locator(".preview-nav").tap();
      await expect(drawer).toBeHidden();
      await expect(touch.getByRole("article", { name: "Preview details" })).toContainText("checkout-layout");
    } finally { await touchContext.close(); }
    const otherTab = await page.context().newPage();
    try {
      await otherTab.goto(launch);
      await expect(otherTab.locator(".overview-table tbody tr")).toHaveCount(100);
      await expect(otherTab.locator(".project-navigation")).toHaveCount(6);
    } finally { await otherTab.close(); }
    await page.setViewportSize({ width: 1024, height: 768 });
    const actionCell = (await tableRows.first().locator("td").last().boundingBox())!;
    const tableBounds = (await page.locator(".overview-table").boundingBox())!;
    expect(Math.abs(actionCell.x + actionCell.width - tableBounds.x - tableBounds.width)).toBeLessThan(3);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await page.getByRole("button", { name: "Dark mode", exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(evidence, `after-100-narrow-${theme}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({ path: join(evidence, `after-100-drawer-${theme}.png`), animations: "disabled" });
      if (theme === "light") {
        await page.setViewportSize({ width: 390, height: 560 });
        const projectNav = page.getByRole("navigation", { name: "Projects", exact: true });
        expect(await projectNav.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        await projectNav.evaluate(element => { element.scrollTop = 0; });
        const box = (await projectNav.boundingBox())!;
        await page.mouse.move(box.x + 20, box.y + 80);
        await page.mouse.wheel(0, 500);
        await expect.poll(() => projectNav.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        const projectToggle = projectNav.getByRole("button", { name: "atlas", exact: true });
        await projectToggle.scrollIntoViewIfNeeded();
        await projectToggle.click();
        await expect(projectNav.locator(".preview-nav")).toHaveCount(0);
        await expect(projectNav.getByRole("button", { name: "studio", exact: true })).toBeInViewport();
        await projectToggle.click();
        await page.setViewportSize({ width: 390, height: 844 });
      }
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 900 });
    await filterBy("Active");
    await expect(tableRows).toHaveCount(2);
    await action(rowFor(tableRows, 0), "Stop");
    await expect(tableRows).toHaveCount(1);
    expect(await (await fetch(neighborUrl)).text()).toBe("<h1>review 1</h1>");
    await action(navigationRow(0), "Start preview");
    await expect(tableRows).toHaveCount(2);
    await action(navigationRow(0), "Stop");
    await expect(tableRows).toHaveCount(1);
    await action(navigationRow(0), "Remove entry…");
    await expect(page.getByRole("alertdialog")).toContainText("projects/atlas/web");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(navigationRow(0).getByRole("button", { name: /^Actions for/ })).toBeFocused();
    await navigationRow(0).locator(".preview-nav").click();
    listGate = new Promise<void>(resolve => { releaseLists = resolve; });
    await action(navigationRow(0), "Remove entry…");
    await page.getByRole("button", { name: "Remove entry", exact: true }).click();
    await fixtures[0].daemon.closed;
    await expect(navigationRow(0)).toHaveCount(0);
    await expect(page.getByText("Preview no longer listed", { exact: true })).toHaveCount(0);
    listGate = undefined; releaseLists();
    await expect(page.getByText("Preview no longer listed", { exact: true })).toBeVisible();
    expect(await (await fetch(neighborUrl)).text()).toBe("<h1>review 1</h1>");
    await overview();
    await filterBy("All");
    await expect(tableRows).toHaveCount(99);
    await rowFor(tableRows, 1).locator(".preview-name").click();
    await overview();
    await rowFor(tableRows, 4).locator(".preview-name").click();
    await page.goBack(); await page.goBack();
    await expect(details).toContainText("checkout-layout");
    await page.goForward(); await page.goForward();
    await expect(details).toContainText("chart-legend");
    await page.reload();
    await expect(details).toContainText("chart-legend");
    await expect(navigationRow(4)).toBeVisible();
    await overview();
    await expect(tableRows).toHaveCount(99);
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("searchbox")).toHaveCount(0);
    const mobileAtlas = drawer.getByRole("button", { name: "atlas", exact: true });
    if (await mobileAtlas.getAttribute("aria-expanded") !== "true") await mobileAtlas.click();
    const mobileRow = rowFor(drawer.locator(".preview-nav-row"), 1);
    await action(mobileRow, "Recheck status");
    await expect(drawer).toBeVisible();
    await mobileRow.getByRole("button", { name: /^Actions for/ }).click();
    await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, "after-100-narrow.png") });
    await page.keyboard.press("Escape");
    await mobileRow.locator(".preview-nav").click();
    await expect(drawer).toBeHidden();
    await page.setViewportSize({ width: 320, height: 740 });
    await overview();
    await search.fill("scratch");
    await expect(tableRows).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    releaseSecond(); releaseThird(); releaseLists();
    await dashboard?.close();
    await Promise.all(fixtures.map(f => f.daemon.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
