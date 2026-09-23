import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import type { PreviewSpec } from "../../src/contracts";

test("React dashboard preserves attempt isolation, logs, configuration and safe controls", async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "previewhost-react-"));
  const runtimes: Awaited<ReturnType<typeof createPreviewRuntime>>[] = [];
  const daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
  const owners: Array<{
    id: string;
    tokenFile: string;
    connection: { endpoint: string; pid: number; projectDirectory: string };
  }> = [];
  const urls: string[] = [];
  const hostnames: string[] = [];
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    for (const folder of [
      "first",
      "second-worktree-with-a-long-feature-branch-directory",
    ]) {
      const project = join(directory, folder);
      await mkdir(project);
      const runtime = await createPreviewRuntime({
        allowedRoots: [project],
        inputs: {
          PREVIEWHOST_DISPOSABLE_APPLICATION_REGION_REFERENCE: "local",
        },
        authorize: () => true,
      });
      runtimes.push(runtime);
      const spec: Extract<PreviewSpec, { type: "environment" }> = {
        name: folder === "first"
          ? "app"
          : "checkout-feature-with-long-address-layout-review",
        type: "environment",
        primary: "web",
        services: {
          migrate: {
            type: "job",
            cwd: project,
            command: [
              process.execPath,
              "-e",
              'console.log("Migration complete")',
            ],
          },
          web: {
            type: "command",
            cwd: project,
            dependsOn: ["migrate"],
            env: {
              APPLICATION_REGION: {
                fromEnv: "PREVIEWHOST_DISPOSABLE_APPLICATION_REGION_REFERENCE",
              },
              APPLICATION_MODE: "disposable",
              ...Object.fromEntries(
                Array.from({ length: 24 }, (_, index) => [
                  `OPTION_${index}`,
                  "local",
                ]),
              ),
            },
            command: [
              process.execPath,
              "-e",
              `console.log('GET /items');console.log('[browser] request failed');console.log('long line '+ 'x'.repeat(300));console.log('literal <script>window.untrusted=true</script>');require('http').createServer((q,r)=>{if(q.method==='POST'){let text='';q.on('data',chunk=>text+=chunk);q.on('end',()=>{console.log(text);r.end('logged')});return;}r.end('${folder}');}).listen(+process.env.PORT,process.env.HOST)`,
            ],
          },
        },
      };
      const started = await runtime.start(spec);
      const ready = await runtime.wait(spec.name, started.candidate!.id);
      expect(ready.state).toBe("ready");
      urls.push(ready.url!);
      hostnames.push(ready.services!.web.browserUrl!);
      const tokenFile = join(directory, folder + "-owner/token");
      const daemon = await startDaemon({
        runtime,
        tokenFile,
        port: 0,
        owner: {
          projectDirectory: project,
          pid: process.pid,
          allowedRoots: [project],
          allowExec: true,
          inputKeys: [],
          secretIds: [],
        },
      });
      daemons.push(daemon);
      owners.push({
        id: createHash("sha256").update(project).digest("hex"),
        tokenFile,
        connection: {
          endpoint: daemon.endpoint,
          pid: process.pid,
          projectDirectory: project,
        },
      });
      if (folder === "first") {
        spec.services.migrate = {
          type: "job",
          cwd: project,
          command: [
            process.execPath,
            "-e",
            'console.error("Migration failed: missing table");process.exit(2)',
          ],
        };
        const failed = await runtime.replace("app", spec);
        expect((await runtime.wait("app", failed.candidate!.id)).state).toBe(
          "failed",
        );
      }
    }
    let launch = "";
    dashboard = await startDashboard({
      discover: async () => owners,
      openBrowser: async (url) => {
        launch = url;
      },
    });
    await dashboard.open();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).policyViolations = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        (window as any).policyViolations.push(event.violatedDirective),
      );
    });
    let failLogs = false;
    let slowLogs = false;
    await page.route("**/api", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "logs" && failLogs)
        return route.fulfill({
          status: 400,
          json: {
            error: { code: "NOT_FOUND", message: "Output unavailable. Retry." },
          },
        });
      if (body.action === "logs" && slowLogs)
        await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.goto(launch).catch(() => {
      throw new Error("The authenticated dashboard could not open.");
    });
    await expect(page.locator(".overview-table .preview-name")).toHaveCount(2);
    await page
      .locator(".overview-table")
      .getByRole("button", { name: "app", exact: true })
      .first()
      .click();
    await expect(page.locator(".preview-title")).toContainText("Update failed");
    await expect(page.locator(".attempt-split")).toContainText("Serving");
    await expect(page.getByRole("heading", { name: "Services · serving", exact: true })).toBeVisible();
    await expect(page.locator(".attempt-split .attempt-failure")).toContainText("migrate");
    await page.screenshot({ path: "/tmp/previewhost-attempts-light.png", animations: "disabled" });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/ph-dark/);
    await page.screenshot({ path: "/tmp/previewhost-attempts-dark.png", animations: "disabled" });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Open app", exact: true }),
    ).toHaveAttribute("href", urls[0]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy URL", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      urls[0],
    );
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Copy URL", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".preview-address a")).toHaveAttribute(
      "href",
      hostnames[0],
    );
    await page.getByRole("button", { name: "Copy hostname URL" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(hostnames[0]);
    const app = await context.newPage();
    await app.goto(urls[0]);
    await expect(app.locator("body")).toHaveText("first");
    await app.goto(hostnames[0]);
    await expect(app.locator("body")).toHaveText("first");
    await app.close();
    await page
      .locator(".attempt-split .attempt-failure")
      .getByRole("button", { name: "Logs", exact: true })
      .click();
    await expect(page.getByRole("combobox", { name: "Log source" })).toHaveText(
      "migrate",
    );
    await expect(page.locator(".logs")).toContainText("missing table");
    await page.getByRole("searchbox", { name: "Search logs" }).fill("MISSING");
    await expect(page.locator(".logs")).toContainText("missing table");
    await page
      .getByRole("searchbox", { name: "Search logs" })
      .fill("absent phrase");
    await expect(page.locator(".logs")).toContainText("No matching lines");
    await page.getByRole("searchbox", { name: "Search logs" }).press("Escape");
    failLogs = true;
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .last()
      .click();
    await expect(
      page.getByText("Details unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Search logs" }),
    ).toBeDisabled();
    await expect(page.locator(".logs")).toHaveCount(0);
    failLogs = false;
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .last()
      .click();
    await expect(page.locator(".logs")).toContainText("missing table");
    const top = (await page.locator(".diagnostic-toolbar").boundingBox())!.y;
    slowLogs = true;
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .last()
      .click();
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Save as preview.yaml" }),
    ).toBeVisible();
    expect((await page.locator(".diagnostic-toolbar").boundingBox())!.y).toBe(
      top,
    );
    await page.waitForTimeout(400);
    await expect(
      page.getByRole("tab", { name: "Configuration", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".logs")).toHaveCount(0);
    slowLogs = false;
    // Reference content needs real reading room, not an action column's minimum width.
    const bindingRow = page
      .getByRole("row")
      .filter({ hasText: "web.APPLICATION_REGION" });
    const reference = bindingRow.getByRole("cell").nth(2);
    expect((await reference.boundingBox())!.width).toBeGreaterThan(240);
    expect((await bindingRow.boundingBox())!.height).toBeLessThan(100);
    await expect(reference).toContainText(
      "PREVIEWHOST_DISPOSABLE_APPLICATION_REGION_REFERENCE",
    );
    const envScroll = page.locator(
      '.env-table [data-slot="scroll-area-viewport"]',
    );
    expect(
      (await page.locator(".env-table").boundingBox())!.height,
    ).toBeLessThanOrEqual(322);
    expect(
      await envScroll.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    const headingY = (await page.locator(".env-table thead").boundingBox())!.y;
    await envScroll.evaluate((element) =>
      element.scrollTo(0, element.scrollHeight),
    );
    expect(
      await envScroll.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    expect((await page.locator(".env-table thead").boundingBox())!.y).toBe(
      headingY,
    );
    const yml = join(directory, "first/preview.yml");
    await writeFile(yml, "name: app\ntype: static\ndirectory: .\n");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("preview.yml exists.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Save as preview.yaml" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "preview.yml" })).toBeVisible();
    await expect(readFile(join(directory, "first/preview.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(yml);
    await page.getByRole("button", { name: "Save as preview.yaml" }).click();
    await expect
      .poll(() =>
        readFile(join(directory, "first/preview.yaml"), "utf8").catch(() => ""),
      )
      .toContain("name: app");
    await page.getByRole("button", { name: "Save as preview.yaml" }).click();
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "already exists" }).filter({ hasText: "preview.yaml" }),
    ).toBeVisible();
    await writeFile(yml, "name: app\ntype: static\ndirectory: .\n");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.getByText("Configuration needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText(/Both preview.yaml and preview.yml exist/)).toBeVisible();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(page.getByText(/Both preview.yaml and preview.yml exist/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".activity-panel").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByText(/Both preview.yaml and preview.yml exist/).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 900 });
    await rm(yml);
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Configuration needs attention", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/ph-dark/);
    await page.getByRole("button", { name: "Dark mode", exact: true }).press("Space");
    await expect(page.locator("body")).not.toHaveClass(/ph-dark/);
    await page.getByRole("button", { name: "Dark mode", exact: true }).press("Space");
    await expect(page.locator("body")).toHaveClass(/ph-dark/);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(
        page.getByRole("tab", { name: "Configuration", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByRole("button", { name: "Save as preview.yaml" }),
      ).toBeInViewport();
    }
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "All previews", exact: false })
      .click();
    for (const path of await page.locator(".overview-table .path").all()) {
      expect((await path.boundingBox())!.height).toBeLessThan(24);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await page
      .getByRole("button", { name: "All previews", exact: false })
      .click();
    await page.locator(".overview-table .preview-name").nth(1).click();
    for (const width of [820, 320, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const selector of [".preview-address", ".service-address"]) {
        const box = (await page.locator(selector).first().boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start preview", exact: true }),
    ).toBeVisible();
    expect((await fetch(urls[0])).status).toBe(200);
    await page
      .getByRole("button", { name: "Start preview", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Open app", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await page.getByRole("combobox", { name: "Log source" }).click();
    await page.getByRole("option", { name: "web", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("<script>");
    await expect(page.locator(".logs")).toContainText("[browser] request failed");
    const logPanel = page.getByRole("region", { name: "Log output" });
    expect(
      await logPanel.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "Wrap lines", exact: true }).click();
    expect(
      await logPanel.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Wrap lines" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".logs")).toContainText("[browser] request failed");
    const current = await runtimes[1].get("checkout-feature-with-long-address-layout-review");
    const currentUrl = current.url!;
    const currentId = current.active!.id;
    const emit = async (text: string) => {
      expect((await fetch(currentUrl, { method: "POST", body: text + "\n" + ".".repeat(256) })).status).toBe(200);
      await expect.poll(async () => (await runtimes[1].logs(current.name, currentId, { source: "web" })).text).toContain(text.slice(-30));
    };
    await emit(Array.from({ length: 100 }, (_, index) => `before clear ${index}`).join("\n"));
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("before clear 99");
    await logPanel.evaluate(el => el.scrollTop = 80);
    const scrollTop = await logPanel.evaluate(el => el.scrollTop);
    await emit("refresh marker");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("refresh marker");
    expect(await logPanel.evaluate(el => el.scrollTop)).toBe(scrollTop);
    await page.getByRole("searchbox", { name: "Search logs" }).fill("marker");
    await page.getByRole("button", { name: "Clear view", exact: true }).click();
    await expect(page.locator(".logs")).not.toContainText("refresh marker");
    await emit("after clear marker 🙂");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("after clear marker 🙂");
    await expect(page.locator(".logs")).not.toContainText("refresh marker");
    await expect(page.getByRole("searchbox", { name: "Search logs" })).toHaveValue("marker");
    await expect(page.getByRole("combobox", { name: "Log source" })).toHaveText("web");
    await page.screenshot({ path: "/tmp/previewhost-clear-logs-dark.png" });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "Clear view", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Show earlier logs", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Clear view", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Wrap lines", exact: true })).toBeFocused();
    await page.screenshot({ path: "/tmp/previewhost-clear-logs-narrow.png" });
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByRole("combobox", { name: "Log source" }).click();
    await page.getByRole("option", { name: "All output", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("after clear marker");
    await expect(page.locator(".logs")).not.toContainText("refresh marker");
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(page.locator(".logs")).not.toContainText("refresh marker");
    // Clearing this view never alters the API reader or another browser's captured output.
    expect((await runtimes[1].logs(current.name, currentId)).text).toContain("refresh marker");
    const independent = await context.newPage();
    await independent.goto(launch);
    await independent.locator(".overview-table .preview-name").filter({ hasText: current.name }).click();
    await independent.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(independent.locator(".logs")).toContainText("refresh marker");
    await independent.close();
    await page.getByRole("button", { name: "Show earlier logs", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("refresh marker");
    await page.getByRole("button", { name: "Clear view", exact: true }).click();
    await emit("x".repeat(70000) + "retained marker 🙂");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Earlier output omitted" })).toBeVisible();
    await expect(page.locator(".logs")).toContainText("retained marker 🙂");
    await page.getByRole("button", { name: "Show earlier logs", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Earlier output omitted" })).toBeVisible();
    // An agent's replacement must not silently move the currently inspected attempt.
    await page.getByRole("button", { name: "Clear view", exact: true }).click();
    const failedApi = await runtimes[1].replace(current.name, {
      name: current.name, type: "environment", primary: "web",
      services: {
        api: { type: "command", cwd: owners[1].connection.projectDirectory, command: [process.execPath, "-e", 'console.error("API startup failed: disposable fixture");process.exit(7)'] },
        web: { type: "static", directory: owners[1].connection.projectDirectory, dependsOn: ["api"] },
      },
    });
    expect((await runtimes[1].wait(current.name, failedApi.candidate!.id)).state).toBe("failed");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Diagnostic attempt" })).toContainText(currentId.slice(0, 8));
    await expect(page.locator(".logs")).not.toContainText("API startup failed");
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(page.locator(".attempt-failure")).toContainText("api");
    await expect(page.getByRole("link", { name: "Open app", exact: true })).toHaveAttribute("href", currentUrl);
    expect((await fetch(currentUrl)).status).toBe(200);
    await page.locator(".attempt-failure").getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Diagnostic attempt" })).toContainText(failedApi.candidate!.id.slice(0, 8));
    await expect(page.getByRole("combobox", { name: "Log source" })).toHaveText("api");
    await expect(page.locator(".logs")).toContainText("API startup failed");
    await page.getByRole("button", { name: "Clear view", exact: true }).click();
    await expect(page.locator(".logs")).not.toContainText("API startup failed");
    await page.getByRole("combobox", { name: "Diagnostic attempt" }).click();
    await page.getByRole("option", { name: `Serving · ${currentId.slice(0, 8)}` }).click();
    await expect(page.getByRole("button", { name: "Show earlier logs", exact: true })).toHaveCount(0);
    await expect(page.locator(".logs")).toContainText("retained marker");
    expect(
      await page.evaluate(() => (window as any).untrusted),
    ).toBeUndefined();
    expect(await page.evaluate(() => (window as any).policyViolations)).toEqual(
      [],
    );
    expect(errors).toEqual([]);
  } finally {
    await dashboard?.close();
    for (const daemon of daemons) await daemon.close();
    for (const runtime of runtimes) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
