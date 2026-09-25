import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { projectLabels, entryLabel, projectGroups, visibleEntries, type Owner } from "../src/lib/model";
import { searchLogs } from "../src/lib/log-search";

test("log search retains ordered, nonduplicated context around case-insensitive matches", () => {
  const text = "start\na\nError one\nb\nError two\nc\nd\ne\nf\ng\nh\nError three\nend";
  expect(searchLogs(text, "ERROR", false)).toEqual({ count: 3, text: "Error one\nError two\nError three" });
  expect(searchLogs(text, "ERROR", true)).toEqual({ count: 3, text: "start\na\nError one\nb\nError two\nc\nd\n…\ng\nh\nError three\nend" });
  expect(searchLogs(text, "absent", true)).toEqual({ count: 0, text: "" });
});

test("navigation labels distinguish folders without merging owners and keep cleanup sources searchable", () => {
  const owners: Owner[] = [
    { id: "main", project: "/work/store/app" },
    { id: "tree", project: "/work/feature/app" },
    { id: "unrelated", project: "/other/store/app" },
    { id: "posix", project: "/work/my\\project" },
    { id: "windows", project: "C:\\work\\checkout\\app" },
    { id: "unknown" },
  ];
  const labels = projectLabels(owners);
  expect(labels.size).toBe(owners.length);
  expect(labels.get("main")).toEqual({ name: "app", qualifier: "work/store" });
  expect(labels.get("unrelated")).toEqual({ name: "app", qualifier: "other/store" });
  expect(labels.get("tree")).toEqual({ name: "app", qualifier: "feature" });
  expect(labels.get("posix")).toEqual({ name: "my\\project", qualifier: "" });
  expect(labels.get("windows")).toEqual({ name: "app", qualifier: "checkout" });
  expect(labels.get("unknown")!.qualifier).toBe("unknown");
  const owner: Owner = { id: "multi", project: "/work/app", previews: [
    { name: "app", busy: false, cleanup: [{ attemptId: "old", error: { code: "CLEANUP_INCOMPLETE", message: "Process still exists" }, sources: ["/old/backend"] }] },
    { name: "comparison", busy: false },
  ] };
  expect(entryLabel({ owner, name: "app" }, projectGroups([owner], visibleEntries([owner], "", "all"))[0]).name).toBe("app");
  expect(visibleEntries([owner], "OLD/BACKEND", "attention").map(entry => entry.name)).toEqual(["app"]);
});

test("repository groups keep clone identity, subprojects and multiple previews distinct", () => {
  const main: Owner = { id: "main", project: "/work/shop", git: { root: "/work/shop", commonDirectory: "/work/shop/.git", branch: "main" }, previews: [{ name: "app", busy: false }] };
  const tree: Owner = { id: "tree", project: "/trees/shop", git: { ...main.git!, root: "/trees/shop", branch: "checkout" }, previews: [{ name: "review", busy: false }, { name: "compare", busy: false }] };
  const clone: Owner = { ...main, id: "clone", project: "/client/shop", git: { ...main.git!, root: "/client/shop", commonDirectory: "/client/shop/.git" } };
  const nested: Owner = { ...main, id: "nested", project: "/work/shop/apps/api" };
  const duplicate: Owner = { ...main, id: "duplicate", project: "/forced/shop", git: { ...main.git!, root: "/forced/shop" } };
  const owners = [main, tree, clone, nested, duplicate];
  const groups = projectGroups(owners, visibleEntries(owners, "", "all"));
  expect(groups).toHaveLength(2);
  const group = groups.find(group => group.id === main.git!.commonDirectory)!;
  expect(group.entries).toHaveLength(5);
  const label = (id: string, name: string) => entryLabel(group.entries.find(entry => entry.owner.id === id && entry.name === name)!, group);
  expect(label("tree", "review")).toEqual({ name: "checkout · review", qualifier: "" });
  expect(label("tree", "compare")).toEqual({ name: "checkout · compare", qualifier: "" });
  expect(label("nested", "app")).toEqual({ name: "main / apps/api", qualifier: "" });
  expect(label("main", "app").qualifier).toBe("work/shop");
  expect(label("duplicate", "app").qualifier).toBe("forced/shop");
  expect(groups.map(group => group.label.qualifier).sort()).toEqual(["client", "work"]);
  expect(visibleEntries(owners, "checkout", "all").map(entry => entry.name).sort()).toEqual(["compare", "review"]);
  const root: Owner = { ...main, previews: [{ name: "api", busy: false }, { name: "web", busy: false }] };
  const subproject: Owner = { ...main, id: "subproject", project: "/work/shop/web" };
  const monorepo = projectGroups([root, subproject])[0];
  const names = monorepo.entries.map(entry => entryLabel(entry, monorepo).name);
  expect(new Set(names).size).toBe(3);
  expect(names).toContain("main · web");
  expect(names).toContain("main / web");
  const detached: Owner = { ...main, id: "detached", project: "/trees/main", git: { ...main.git!, root: "/trees/main", branch: undefined } };
  const sameName = projectGroups([main, detached])[0];
  expect(sameName.entries.map(entry => entryLabel(entry, sameName))).toEqual([
    { name: "main", qualifier: "" }, { name: "main (folder)", qualifier: "" },
  ]);
});

test("New preview keeps configuration through review and preserves unsaved service edits across tabs", async ({ page }) => {
  test.setTimeout(60_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "previewhost-create-ui-")));
  const project = join(directory, "existing-worktree-with-long-source-folder-name-for-layout-review");
  await mkdir(project);
  await writeFile(join(project, "server.cjs"), "require('http').createServer((q,r)=>r.end(process.env.APPLICATION_MODE)).listen(+process.env.PORT,process.env.HOST)");
  const runtime = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
  const tokenFile = join(directory, "owner/token");
  const daemon = await startDaemon({ runtime, tokenFile, port: 0, owner: {
    projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [],
  } });
  let launch = "";
  const dashboard = await startDashboard({
    discover: async () => [{ id: createHash("sha256").update(project).digest("hex"), tokenFile, connection: { endpoint: daemon.endpoint, pid: process.pid, projectDirectory: project } }],
    openBrowser: async url => { launch = url; },
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const jobs = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`prepare-${index}`, {
      type: "job" as const, cwd: project, command: [process.execPath, "-e", `console.log('Preparation ${index}: ${"long command argument for review ".repeat(8)}')`],
      env: { JOB_MODE: "fixture" },
    }]));
    const spec: PreviewSpec = { name: "from-dashboard", type: "environment", primary: "web", services: {
      ...jobs,
      web: { type: "command", cwd: project, command: [process.execPath, "server.cjs"], dependsOn: Object.keys(jobs), env: {
        APPLICATION_MODE: "initial", ...Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`OPTION_${index}`, "fixture"])),
      } },
    } };
    const text = JSON.stringify(spec, null, 2);
    await dashboard.open();
    await page.goto(launch);
    await expect(page).toHaveTitle("Previews · Previewhost");
    const create = page.getByRole("button", { name: "New preview", exact: true });
    await create.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New preview", exact: true })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Project folder", exact: true })).toBeFocused();
    await dialog.getByRole("combobox", { name: "Project folder", exact: true }).click();
    await page.getByRole("option", { name: project, exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Absolute project folder" })).toHaveValue(project);
    await dialog.getByRole("button", { name: "Review preview", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Configuration", exact: true }).click();
    await page.getByRole("option", { name: "YAML or JSON without a file", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Format", exact: true }).click();
    await page.getByRole("option", { name: "JSON", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Preview configuration", exact: true }).fill(text);
    await dialog.getByRole("button", { name: "Review preview", exact: true }).press("Enter");
    await expect(dialog.getByRole("heading", { name: "Start preview", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Start preview", exact: true })).toBeDisabled();
    expect((await runtime.list())).toHaveLength(0);
    for (const theme of ["light", "dark"]) {
      // Theme changes use the existing control before reopening the review.
      if (theme === "dark") {
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "Preview configuration", exact: true })).toHaveValue(text);
        await page.keyboard.press("Escape");
        await expect(create).toBeFocused();
        await page.getByRole("button", { name: "Dark mode", exact: true }).click();
        await create.click();
        await dialog.getByRole("textbox", { name: "Absolute project folder" }).fill(project);
        await dialog.getByRole("combobox", { name: "Configuration", exact: true }).click();
        await page.getByRole("option", { name: "YAML or JSON without a file", exact: true }).click();
        await dialog.getByRole("textbox", { name: "Preview configuration", exact: true }).fill(text);
        await dialog.getByRole("button", { name: "Review preview", exact: true }).click();
        await expect(dialog.getByRole("heading", { name: "Start preview", exact: true })).toBeVisible();
      }
      for (const width of [1360, 390]) {
        await page.setViewportSize({ width, height: 700 });
        await expect(dialog.getByRole("button", { name: "Start preview", exact: true })).toBeInViewport();
        await expect(dialog.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const body = dialog.locator(".workflow-body");
        expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        await dialog.locator('.workflow-consent').scrollIntoViewIfNeeded();
        await expect(dialog.getByRole("checkbox")).toBeInViewport();
        await expect.poll(() => body.evaluate(element => {
          const consent = element.querySelector('.workflow-consent')!;
          return consent.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1;
        })).toBe(true);
        await page.screenshot({ path: `/tmp/previewhost-create-${width}-${theme}.png`, animations: "disabled" });
      }
    }
    await dialog.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(dialog.getByRole("button", { name: "Start preview", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Start preview", exact: true }).press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open app", exact: true })).toBeVisible();
    const ready = await runtime.get(spec.name);
    expect(await (await fetch(ready.url!)).text()).toBe("initial");
    await expect(readFile(join(project, "preview.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit JOB_MODE", exact: true })).toBeVisible();
    expect((await page.locator(".editable-env-table").boundingBox())!.height).toBeLessThan(180);
    await page.screenshot({ path: "/tmp/previewhost-config-short-390-dark.png", animations: "disabled" });
    await page.getByRole("combobox", { name: "Service or job", exact: true }).click();
    await page.getByRole("option", { name: "web · command", exact: true }).click();
    const viewport = page.locator('.editable-env-table [data-slot="scroll-area-viewport"]');
    expect(await viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.getByRole("button", { name: "Edit APPLICATION_MODE", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Keep change", exact: true })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "Replace the existing value", exact: true }).check();
    await dialog.getByRole("textbox", { name: "Replacement value", exact: true }).fill("edited");
    await dialog.getByRole("button", { name: "Keep change", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit APPLICATION_MODE", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Remove OPTION_0", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(page.locator(".logs")).toBeVisible();
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await expect(page.getByText("2 unsaved changes.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo removal of OPTION_0", exact: true }).click();
    await expect(page.getByText("1 unsaved change.", { exact: true })).toBeVisible();
    expect(await (await fetch(ready.url!)).text()).toBe("initial");
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.getByRole("button", { name: "Dark mode", exact: true }).click();
      for (const width of [1360, 390]) {
        await page.setViewportSize({ width, height: 700 });
        await expect(page.getByRole("button", { name: "Review and apply", exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator('.configuration-source').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/previewhost-config-${width}-${theme}.png`, animations: "disabled" });
      }
    }
    await page.getByRole("button", { name: "Review and apply", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Apply configuration", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Review and apply", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("heading", { name: "Apply configuration", exact: true })).toBeVisible();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Apply configuration", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await fetch(ready.url!)).text()).toBe("edited");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.close();
    await daemon.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
  const logOption = async (name: string, checkbox = false) => {
    await page.getByRole("button", { name: "Log options", exact: true }).click();
    await page.getByRole(checkbox ? "menuitemcheckbox" : "menuitem", { name, exact: true }).click();
  };
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
        if (spec.services.web.type === "command") {
          spec.services.web.env = { ...spec.services.web.env, FAILED_UPDATE_ONLY: "disposable" };
        }
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
    await expect(page).toHaveTitle("Previews · Previewhost");
    await page.locator('.overview-table .preview-name[title$="/first"]').click();
    await expect(page).toHaveTitle(/first.* · Previewhost$/);
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
    await page.getByRole("button", { name: "Copy localhost URL", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      urls[0],
    );
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Copy localhost URL", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".preview-address a")).toHaveCount(2);
    await expect(page.locator(".preview-address a").nth(0)).toHaveAttribute("href", hostnames[0]);
    await expect(page.locator(".preview-address a").nth(1)).toHaveAttribute("href", urls[0]);
    await page.keyboard.press("Tab");
    await page.locator(".preview-address a").first().focus();
    expect(await page.locator(".preview-address a").first().evaluate(element => {
      const css = getComputedStyle(element);
      return { outline: css.outlineStyle, border: css.borderWidth, shadow: css.boxShadow };
    })).toEqual({ outline: "none", border: "0px", shadow: "none" });
    const folders = page.getByRole("button", { name: "Source folders", exact: true });
    await folders.focus();
    await page.keyboard.press("Enter");
    await expect(folders).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".source-folders")).toContainText(join(directory, "first"));
    await page.locator(".source-folders").getByRole("button", { name: "Copy path" }).first().click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(await realpath(join(directory, "first")));
    await folders.focus();
    await page.keyboard.press("Space");
    await expect(folders).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Copy hostname URL" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(hostnames[0]);
    const [app] = await Promise.all([
      context.waitForEvent("page"),
      page.locator(".preview-address a").nth(1).click(),
    ]);
    await expect(app.locator("body")).toHaveText("first");
    await app.close();
    const [hostnameApp] = await Promise.all([
      context.waitForEvent("page"),
      page.locator(".preview-address a").nth(0).click(),
    ]);
    await expect(hostnameApp.locator("body")).toHaveText("first");
    expect(hostnameApp.url()).toBe(hostnames[0] + "/");
    await hostnameApp.close();
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
    await page.getByRole("combobox", { name: "Configuration source" }).click();
    await page.getByRole("option", { name: "Failed update configuration", exact: true }).click();
    await page.getByRole("combobox", { name: "Service or job" }).click();
    await page.getByRole("option", { name: "web · command", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit FAILED_UPDATE_ONLY", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Configuration source" }).click();
    await page.getByRole("option", { name: "Current configuration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit APPLICATION_MODE", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit FAILED_UPDATE_ONLY", exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Configuration source" }).click();
    await page.getByRole("option", { name: "Recorded attempt", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Edit APPLICATION/ })).toHaveCount(0);
    const configuration = page.getByRole("button", { name: "Requested configuration", exact: true });
    await configuration.focus();
    await page.keyboard.press("Enter");
    await expect(configuration).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("pre.configuration")).toContainText('"type": "environment"');
    await page.keyboard.press("Space");
    await expect(configuration).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("pre.configuration")).toBeHidden();
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
    await expect(page.locator(".save-row")).toContainText("preview.yml");
    await expect(page.getByRole("button", { name: "Save as preview.yaml" })).toHaveCount(0);
    await expect(readFile(join(directory, "first/preview.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(yml);
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Save as preview.yaml" }).click();
    await expect
      .poll(() =>
        readFile(join(directory, "first/preview.yaml"), "utf8").catch(() => ""),
      )
      .toContain("name: app");
    await expect(page.getByRole("button", { name: "Save as preview.yaml" })).toHaveCount(0);
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
        page.locator(".save-row"),
      ).toBeInViewport();
    }
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1360, height: 900 });
    await page
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await page.locator(".overview-table .preview-name").filter({ hasText: "checkout-feature-with-long-address-layout-review" }).click();
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
    await logOption("Wrap lines", true);
    expect(
      await logPanel.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await page.getByRole("button", { name: "Log options", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Wrap lines" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
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
    await logOption("Include surrounding lines", true);
    await expect(page.locator(".logs")).toContainText("before clear 99");
    await logOption("Include surrounding lines", true);
    await expect(page.locator(".logs")).not.toContainText("before clear 99");
    await logOption("Clear view");
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
    const attemptBox = (await page.getByRole("combobox", { name: "Diagnostic attempt" }).boundingBox())!;
    expect(attemptBox.width).toBeGreaterThan(220);
    await page.getByRole("button", { name: "Log options", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemcheckbox", { name: "Wrap lines" })).toBeFocused();
    await expect(page.getByRole("menuitem", { name: "Clear view", exact: true })).toBeInViewport();
    await expect(page.getByRole("menuitem", { name: "Show earlier logs", exact: true })).toBeInViewport();
    await page.screenshot({ path: "/tmp/previewhost-log-options-narrow.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Log options", exact: true })).toBeFocused();
    await page.screenshot({ path: "/tmp/previewhost-clear-logs-narrow.png" });
    await page.setViewportSize({ width: 1360, height: 900 });
    // Compare another worktree, then restore this diagnostic view through Back and reload.
    const firstProject = page.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button", { name: "first", exact: true });
    if (await firstProject.getAttribute("aria-expanded") !== "true") await firstProject.click();
    await page.locator('.preview-nav[title$="/first · app"]').click();
    await page.goBack();
    await expect(page.getByRole("searchbox", { name: "Search logs" })).toHaveValue("marker");
    await expect(page.getByRole("combobox", { name: "Log source" })).toHaveText("web");
    await expect(page.locator(".logs")).not.toContainText("refresh marker");
    await page.reload();
    await expect(page.getByRole("tab", { name: "Logs", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".logs")).toContainText("after clear marker");
    await expect(page.locator(".logs")).not.toContainText("refresh marker");
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
    await independent.locator(".overview-table .preview-name").filter({ hasText: "checkout-feature-with-long-address-layout-review" }).click();
    await independent.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(independent.locator(".logs")).toContainText("refresh marker");
    await independent.close();
    await logOption("Show earlier logs");
    await expect(page.locator(".logs")).toContainText("refresh marker");
    await logOption("Clear view");
    await emit("x".repeat(70000) + "retained marker 🙂");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Earlier output omitted" })).toBeVisible();
    await expect(page.locator(".logs")).toContainText("retained marker 🙂");
    await logOption("Show earlier logs");
    await expect(page.getByRole("status").filter({ hasText: "Earlier output omitted" })).toBeVisible();
    // An agent's replacement must not silently move the currently inspected attempt.
    await logOption("Clear view");
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
    await logOption("Clear view");
    await expect(page.locator(".logs")).not.toContainText("API startup failed");
    await page.getByRole("combobox", { name: "Diagnostic attempt" }).click();
    await page.getByRole("option", { name: `Serving · ${currentId.slice(0, 8)}` }).click();
    await page.getByRole("button", { name: "Log options", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Show earlier logs", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".logs")).toContainText("retained marker");
    expect(
      await page.evaluate(() => (window as any).untrusted),
    ).toBeUndefined();
    expect(await page.evaluate(() => (window as any).policyViolations)).toEqual(
      [],
    );
    expect(errors).toEqual([]);
    // A canceled dependency chain can be started explicitly through the same workflow.
    const project = owners[0].connection.projectDirectory;
    await writeFile(join(project, "index.html"), "onboarding complete");
    const pipeline: PreviewSpec = {
      name: "onboarding", type: "environment", primary: "web",
      services: {
        prepare: { type: "job", cwd: project, command: [process.execPath, "-e",
          "const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync('continue')){clearInterval(timer);console.log('Dependencies ready')}},20)"] },
        migrate: { type: "job", cwd: project, dependsOn: ["prepare"], command: [process.execPath, "-e", "console.log('Schema ready')"] },
        web: { type: "static", directory: project, dependsOn: ["migrate"] },
      },
    };
    const preparing = await runtimes[0].start(pipeline);
    await expect.poll(async () => (await runtimes[0].get(pipeline.name)).candidate?.services?.prepare.state).toBe("starting");
    await page.getByRole("banner").getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator('.overview-table .preview-name[aria-label$=" · onboarding"]').click();
    await expect(page.getByRole("row").filter({ hasText: "migrate" }).last()).toContainText("prepare");
    await page.screenshot({ path: "/tmp/previewhost-progress-dark.png", animations: "disabled" });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/previewhost-progress-narrow.png", animations: "disabled" });
    await page.getByRole("button", { name: "Cancel startup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start preview", exact: true })).toBeVisible();
    expect((await runtimes[0].wait(pipeline.name, preparing.candidate!.id)).state).toBe("canceled");
    await page.screenshot({ path: "/tmp/previewhost-canceled-narrow.png", animations: "disabled" });
    await writeFile(join(project, "continue"), "ready");
    await page.getByRole("button", { name: "Start preview", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open app", exact: true })).toBeVisible();
    const resumed = await runtimes[0].get(pipeline.name);
    expect(resumed.active?.id).not.toBe(preparing.candidate!.id);
    expect(await (await fetch(resumed.url!)).text()).toBe("onboarding complete");
    expect(errors).toEqual([]);
  } finally {
    await dashboard?.close();
    for (const daemon of daemons) await daemon.close();
    for (const runtime of runtimes) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
