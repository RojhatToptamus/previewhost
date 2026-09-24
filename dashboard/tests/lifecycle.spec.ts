import { test, expect, type Locator } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("linked worktrees stay grouped, discoverable and independently controllable", async ({ page }) => {
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
    await page.route("**/api", async route => {
      const input = route.request().postDataJSON();
      if (input.action === "list") {
        if (holdPages && input.after === sorted[15].id) await secondPage;
        if (holdPages && input.after === sorted[31].id) await thirdPage;
        if (listGate) await listGate;
      }
      if (input.action === "recheck" && rejectRecheck) {
        await route.fulfill({ json: { error: { code: "TIMEOUT", message: "Fixture owner did not respond." } } });
      } else await route.continue();
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
    const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "Search previews" });
    const filter = page.getByRole("combobox", { name: "Filter previews" });
    async function filterBy(name: string) {
      await filter.click(); await page.getByRole("option", { name, exact: true }).click();
    }
    async function action(row: Locator, index: number, name: string) {
      await row.getByRole("button", { name: `Actions for ${fixtures[index].name}` }).click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    }
    async function capture(count: number) {
      await expect(page.getByRole("status", { name: "Loading remaining previews" })).toHaveCount(0);
      const notifications = page.locator("[data-sonner-toast]");
      while (await notifications.count()) {
        const remaining = await notifications.count();
        await notifications.first().getByRole("button", { name: "Close toast" }).click();
        await expect(notifications).toHaveCount(remaining - 1);
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
    await refresh();
    await expect(tableRows).toHaveCount(10);
    await expect(rowFor(tableRows, 1)).toContainText("checkout-layout");
    await expect(rowFor(tableRows, 2)).toContainText("feature-pricing");
    await filterBy("Needs attention");
    await expect(tableRows).toHaveCount(2);
    await filterBy("Stopped / offline");
    await expect(tableRows).toHaveCount(7);
    await filterBy("All statuses");
    await search.fill("scratch");
    await expect(tableRows).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "receipt-checker" })).toBeVisible();
    await search.fill("projects/atlas/api");
    await expect(tableRows).toHaveCount(1);
    await expect(rowFor(tableRows, 0)).toBeVisible();
    await search.fill("");
    await capture(10);
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
    // Keyboard selection opens the exact worktree without changing project identity.
    await rowFor(tableRows, 0).locator(".preview-name").focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("article", { name: "Preview details" });
    await expect(details).toContainText("projects/atlas/web");
    await expect(navigationRow(0)).toBeVisible();
    await overview();
    await search.fill("checkout-layout");
    await rowFor(tableRows, 1).locator(".preview-name").click();
    await expect(details).toContainText("checkout-layout");
    await expect(navigationRow(0)).toBeVisible();
    await expect(navigationRow(1)).toBeVisible();
    listGate = new Promise<void>(resolve => { releaseLists = resolve; });
    // Sidebar actions operate on their row without leaving the selected environment.
    const stoppedRow = await fixtures[0].runtime.stop(fixtures[0].name);
    await action(navigationRow(0), 0, "Recheck status");
    await expect(navigationRow(0)).toContainText("Stopped");
    await expect(details).toContainText("checkout-layout");
    const resumedRow = await fixtures[0].runtime.startAgain(fixtures[0].name, stoppedRow.latest!.id);
    await fixtures[0].runtime.wait(fixtures[0].name, resumedRow.candidate!.id);
    await action(navigationRow(0), 0, "Recheck status");
    await expect(navigationRow(0)).toContainText("Ready");
    rejectRecheck = true;
    await refresh();
    await expect(details.locator(".preview-title")).toContainText("Unavailable");
    await expect(details.getByRole("link", { name: "Open app", exact: true })).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const stoppedNeighbor = await fixtures[1].runtime.stop(fixtures[1].name);
    rejectRecheck = false;
    await refresh();
    await expect(details.locator(".preview-title")).toContainText("Stopped");
    const restartedNeighbor = await fixtures[1].runtime.startAgain(fixtures[1].name, stoppedNeighbor.latest!.id);
    await fixtures[1].runtime.wait(fixtures[1].name, restartedNeighbor.candidate!.id);
    listGate = undefined; releaseLists();
    await refresh();
    await expect(details.locator(".preview-title")).toContainText("Ready");
    const neighborUrl = (await fixtures[1].runtime.get(fixtures[1].name)).url!;
    await overview();
    await expect(search).toHaveValue("checkout-layout");
    await search.fill("");
    // Long repository groups are bounded; selecting a hidden row reveals it.
    const atlas = nav.locator(".project-navigation").filter({ has: page.getByRole("button", { name: "atlas", exact: true }) });
    await expect(atlas.locator(".preview-nav")).toHaveCount(5);
    const toggle = atlas.getByRole("button", { name: "atlas", exact: true });
    await toggle.focus();
    expect(await toggle.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Space");
    await expect(atlas.locator(".preview-nav")).toHaveCount(0);
    await rowFor(tableRows, 12).locator(".preview-name").click();
    await expect(navigationRow(12)).toBeVisible();
    await expect(atlas.locator(".preview-nav")).toHaveCount(6);
    await overview();
    await atlas.getByRole("button", { name: /^Show all/ }).click();
    expect(await atlas.locator(".preview-nav").count()).toBeGreaterThan(20);
    await atlas.getByRole("button", { name: "Show less" }).click();
    await expect(atlas.locator(".preview-nav")).toHaveCount(5);
    await expect(tableRows).toHaveCount(100);
    await capture(100);
    const otherTab = await page.context().newPage();
    try {
      await otherTab.goto(launch);
      await expect(otherTab.locator(".overview-table tbody tr")).toHaveCount(100);
      await expect(otherTab.locator(".project-navigation")).toHaveCount(6);
    } finally { await otherTab.close(); }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await page.getByRole("button", { name: "Dark mode", exact: true }).click();
      await page.screenshot({ path: join(evidence, `after-100-narrow-${theme}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({ path: join(evidence, `after-100-drawer-${theme}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 900 });
    await filterBy("Active");
    await expect(tableRows).toHaveCount(2);
    await action(rowFor(tableRows, 0), 0, "Stop");
    await expect(tableRows).toHaveCount(1);
    expect(await (await fetch(neighborUrl)).text()).toBe("<h1>review 1</h1>");
    await action(navigationRow(0), 0, "Start preview");
    await expect(tableRows).toHaveCount(2);
    await action(navigationRow(0), 0, "Stop");
    await expect(tableRows).toHaveCount(1);
    await action(navigationRow(0), 0, "Remove entry…");
    await expect(page.getByRole("alertdialog")).toContainText("projects/atlas/web");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(navigationRow(0).getByRole("button", { name: "Actions for web" })).toBeFocused();
    await navigationRow(0).locator(".preview-nav").click();
    listGate = new Promise<void>(resolve => { releaseLists = resolve; });
    await action(navigationRow(0), 0, "Remove entry…");
    await page.getByRole("button", { name: "Remove entry", exact: true }).click();
    await fixtures[0].daemon.closed;
    await refresh();
    await expect(navigationRow(0)).toHaveCount(0);
    await expect(page.getByText("Preview no longer listed", { exact: true })).toHaveCount(0);
    listGate = undefined; releaseLists();
    await expect(page.getByText("Preview no longer listed", { exact: true })).toBeVisible();
    expect(await (await fetch(neighborUrl)).text()).toBe("<h1>review 1</h1>");
    await overview();
    await filterBy("All statuses");
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
    const mobileRow = rowFor(drawer.locator(".preview-nav-row"), 1);
    await action(mobileRow, 1, "Recheck status");
    await expect(drawer).toBeVisible();
    await mobileRow.getByRole("button", { name: "Actions for review" }).click();
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
