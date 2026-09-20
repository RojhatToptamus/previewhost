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
    await page.goto(launch);
    const nav = page.locator('[data-slot="sidebar-content"]');
    await expect(nav.locator(".preview-nav")).toHaveCount(100);
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
    const neighborUrl = (await fixtures[99].runtime.get("app")).url!;
    await search.fill("");
    await filter.selectOption("active");
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
    await filter.selectOption("stopped");
    await search.fill("worktree-098");
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Start preview" }).click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await fixtures[98].runtime.get("app")).active?.state)
      .toBe("ready");
    await filter.selectOption("active");
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
    await filter.selectOption("stopped");
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("worktree-098");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Actions for app" }),
    ).toBeFocused();
    await row.getByRole("button", { name: "Actions for app" }).click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await page
      .getByRole("button", { name: "Remove entry", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect(await (await fetch(neighborUrl)).text()).toBe("99");
    await filter.selectOption("all");
    await search.fill("");
    await page.getByRole("button", { name: /All previews/ }).click();
    await expect(nav.locator(".preview-nav")).toHaveCount(99);
    const evidence = ".local/dashboard-review";
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
    await dashboard?.close();
    await Promise.all(fixtures.map((f) => f.daemon.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
