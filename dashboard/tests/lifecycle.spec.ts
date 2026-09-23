import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("100 previews stay navigable and sidebar actions preserve neighboring previews", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "previewhost-sidebar-"));
  const fixtures: Array<{
    id: string;
    project: string;
    tokenFile: string;
    closed: boolean;
    daemon: Awaited<ReturnType<typeof startDaemon>>;
    runtime: Awaited<ReturnType<typeof createPreviewRuntime>>;
  }> = [];
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let releaseSecond = () => {};
  let releaseThird = () => {};
  let releaseLists = () => {};
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    for (let i = 0; i < 100; i++) {
      const project = join(directory, `worktree-${String(i).padStart(3, "0")}`);
      await mkdir(project);
      await writeFile(join(project, "index.html"), String(i));
      const runtime = await createPreviewRuntime({ allowedRoots: [project] });
      const start = await runtime.start({
        name: "app",
        type: "static",
        directory: project,
      });
      await runtime.wait("app", start.candidate!.id);
      if (i < 98) await runtime.stop("app");
      const tokenFile = join(directory, "owners", String(i), "token");
      const daemon = await startDaemon({
        runtime,
        tokenFile,
        port: 0,
        owner: {
          projectDirectory: project,
          pid: process.pid,
          allowedRoots: [project],
          allowExec: false,
          inputKeys: [],
          secretIds: [],
        },
      });
      const id = createHash("sha256").update(project).digest("hex");
      const fixture = {
        id,
        project,
        runtime,
        daemon,
        tokenFile,
        closed: false,
      };
      fixtures.push(fixture);
      void daemon.closed.then(() => {
        fixture.closed = true;
      });
    }
    let launch = "";
    dashboard = await startDashboard({
      discover: async () =>
        fixtures
          .filter((f) => !f.closed)
          .map((f) => ({
            id: f.id,
            tokenFile: f.tokenFile,
            connection: {
              endpoint: f.daemon.endpoint,
              pid: process.pid,
              projectDirectory: f.project,
            },
          })),
      openBrowser: async (url) => {
        launch = url;
      },
    });
    await dashboard.open();
    const sorted = [...fixtures].sort((a, b) => a.id.localeCompare(b.id));
    const secondPage = new Promise<void>(resolve => { releaseSecond = resolve; });
    const thirdPage = new Promise<void>(resolve => { releaseThird = resolve; });
    let holdPages = true;
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
    await page.goto(launch);
    const nav = page.locator('[data-slot="sidebar-content"]');
    await expect(nav.locator(".preview-nav")).toHaveCount(16);
    await expect(page.getByRole("main").getByRole("table")).toBeVisible();
    releaseSecond();
    await expect(nav.locator(".preview-nav")).toHaveCount(32);
    await expect(page.getByRole("status", { name: "Loading remaining previews" })).toBeVisible();
    await page.screenshot({ path: "/private/tmp/previewhost-progressive-loading.png", animations: "disabled" });
    releaseThird();
    await expect(nav.locator(".preview-nav")).toHaveCount(100);
    holdPages = false;
    await expect(nav.locator(".preview-nav").first()).toContainText(
      "worktree-098",
    );
    expect(await nav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
    const search = page.getByRole("searchbox", { name: "Search previews" });
    const filter = page.getByRole("combobox", { name: "Filter previews" });
    await search.fill("worktree-099");
    await nav.locator(".preview-nav").click();
    await expect(search).toHaveValue("worktree-099");
    const details = page.getByRole("article", { name: "Preview details" });
    await expect(details.locator(".preview-title")).toContainText("Ready");
    listGate = new Promise<void>(resolve => { releaseLists = resolve; });
    // Row recheck updates an unselected owner without waiting for the full scan.
    const stoppedRow = await fixtures[98].runtime.stop("app");
    await search.fill("worktree-098");
    await nav.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Recheck status", exact: true }).click();
    await expect(nav.locator(".preview-nav")).toContainText("Stopped");
    await expect(details).toContainText("worktree-099");
    const resumedRow = await fixtures[98].runtime.startAgain("app", stoppedRow.latest!.id);
    await fixtures[98].runtime.wait("app", resumedRow.candidate!.id);
    await nav.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Recheck status", exact: true }).click();
    await expect(nav.locator(".preview-nav")).toContainText("Ready");
    await search.fill("worktree-099");
    // A selected-owner failure clears stale actions even while the full scan is held.
    rejectRecheck = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(details.locator(".preview-title")).toContainText("Unavailable");
    await expect(details.getByRole("link", { name: "Open app", exact: true })).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(nav.locator(".preview-nav")).toHaveCount(1);
    const stoppedNeighbor = await fixtures[99].runtime.stop("app");
    rejectRecheck = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(details.locator(".preview-title")).toContainText("Stopped");
    await search.fill("");
    await expect(nav.locator(".preview-nav")).toHaveCount(100);
    const restartedNeighbor = await fixtures[99].runtime.startAgain("app", stoppedNeighbor.latest!.id);
    await fixtures[99].runtime.wait("app", restartedNeighbor.candidate!.id);
    listGate = undefined;
    releaseLists();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(details.locator(".preview-title")).toContainText("Ready");
    const neighborUrl = (await fixtures[99].runtime.get("app")).url!;
    await search.fill("");
    await filter.click();
    await page.getByRole("option", { name: "Active", exact: true }).click();
    await expect(nav.locator(".preview-nav")).toHaveCount(2);
    const row = nav
      .locator(".preview-nav-row")
      .filter({ hasText: "worktree-098" });
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(
      page.getByRole("article", { name: "Preview details" }),
    ).toContainText("worktree-099");
    expect(await (await fetch(neighborUrl)).text()).toBe("99");
    await filter.click();
    await page
      .getByRole("option", { name: "Stopped / offline", exact: true })
      .click();
    await search.fill("worktree-098");
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Start preview" }).click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await fixtures[98].runtime.get("app")).active?.state)
      .toBe("ready");
    await filter.click();
    await page.getByRole("option", { name: "Active", exact: true }).click();
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
    await filter.click();
    await page
      .getByRole("option", { name: "Stopped / offline", exact: true })
      .click();
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("worktree-098");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Actions for app" }),
    ).toBeFocused();
    await row.locator(".preview-nav").click();
    listGate = new Promise<void>(resolve => { releaseLists = resolve; });
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await page
      .getByRole("button", { name: "Remove entry", exact: true })
      .click();
    await fixtures[98].daemon.closed;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText("Preview no longer listed", { exact: true })).toHaveCount(0);
    listGate = undefined;
    releaseLists();
    await expect(page.getByText("Preview no longer listed", { exact: true })).toBeVisible();
    expect(await (await fetch(neighborUrl)).text()).toBe("99");
    await filter.click();
    await page
      .getByRole("option", { name: "All statuses", exact: true })
      .click();
    await search.fill("");
    await page.getByRole("button", { name: /All previews/ }).click();
    await expect(nav.locator(".preview-nav")).toHaveCount(99);
    const evidence = "/private/tmp/previewhost-sidebar-review";
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "projects-light.png") });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.screenshot({ path: join(evidence, "projects-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await drawer
      .getByRole("searchbox", { name: "Search previews" })
      .fill("worktree-099");
    await drawer.getByRole("button", { name: "Actions for app" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Stop", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(evidence, "sidebar-narrow.png") });
    await page.keyboard.press("Escape");
    await drawer.locator(".preview-nav").click();
    await expect(drawer).toBeHidden();
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    releaseSecond(); releaseThird(); releaseLists();
    await dashboard?.close();
    await Promise.all(fixtures.map((f) => f.daemon.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
