import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const { startDashboard } = await import(
  new URL("../../dist/dashboard.js", import.meta.url).href
);
const { discoverProjectOwners, writeProjectRecord, readProjectRecord } =
  await import(new URL("../../dist/project.js", import.meta.url).href);
const { createDataOwner } = await import(
  new URL("../../dist/data.js", import.meta.url).href
);

const { createPreviewRuntime } = await import(
  new URL("../../dist/runtime.js", import.meta.url).href
);
const { startDaemon } = await import(
  new URL("../../dist/daemon.js", import.meta.url).href
);

test("unavailable entries can be rechecked and removed only after explicit, guarded cleanup verification", async ({
  page,
}) => {
  const directory = await mkdtemp(
    join(tmpdir(), "previewhost-unavailable-ui-"),
  );
  const owners = join(directory, "owners");
  await mkdir(owners, { mode: 0o700 });
  const dataDirectory = join(directory, "data");
  const data = await createDataOwner({ directory: dataDirectory });
  await data.close();
  const exitedPid = Number(
    execFileSync(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]),
  );
  const rows = [];
  for (const [name, pid] of [
    ["storefront-checkout", exitedPid],
    ["storefront-payments", process.pid],
  ] as const) {
    const projectDirectory = join(directory, name);
    const id = createHash("sha256").update(projectDirectory).digest("hex");
    const path = join(owners, id);
    await mkdir(path, { mode: 0o700 });
    const record = {
      projectDirectory,
      dataDirectory,
      endpoint: "http://127.0.0.1:1",
      pid,
    };
    await writeProjectRecord(path, record);
    rows.push({ path, record });
  }
  let launch = "";
  const dashboard = await startDashboard({
    discover: () => discoverProjectOwners(owners),
    openBrowser: async (url: string) => {
      launch = url;
    },
  });
  let recovered: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const errors: string[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await dashboard.open();
    await page.clock.install();
    await page.goto(launch);
    await expect(page).toHaveTitle("Previews · Previewhost");
    // Open each entry once; recent navigation resolves actions from current owner data.
    for (const name of ["storefront-checkout", "storefront-payments"]) {
      await page.locator(".overview-table .preview-name").filter({ hasText: name }).click();
      await page.getByRole("button", { name: "Overview", exact: true }).click();
    }
    const nav = page.locator('[data-slot="sidebar-content"]');
    await expect(nav.getByRole("button", { name: /^Actions for/ })).toHaveCount(
      2,
    );
    const stale = nav.getByRole("button", {
      name: "Actions for storefront-checkout",
      exact: true,
    });
    await stale.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Recheck status" }).click();
    await expect(page.getByText(/The owner is not responding/)).toBeVisible();
    await page.getByRole("button", { name: "Close toast" }).click();
    await stale.click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("checkbox")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Remove entry", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(stale).toBeFocused();
    expect(await readProjectRecord(rows[0].path)).toEqual(rows[0].record);
    await nav
      .getByRole("button", { name: "Actions for storefront-payments" })
      .click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await expect(dialog).toContainText("recorded process still exists");
    await expect(
      dialog.getByRole("button", { name: "Remove entry", exact: true }),
    ).toBeDisabled();
    const evidence = "/private/tmp/previewhost-sidebar-review";
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "removal-blocked.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("combobox", { name: "Filter previews" }).click();
    await page
      .getByRole("option", { name: "Needs attention", exact: true })
      .click();
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const sheet = page.getByRole("dialog");
    await expect(
      sheet.getByRole("button", { name: /^Actions for/ }),
    ).toHaveCount(2);
    await sheet
      .getByRole("button", { name: "Actions for storefront-checkout" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Remove entry…" }),
    ).toBeVisible();
    await page.screenshot({
      path: join(evidence, "unavailable-mobile.png"),
      animations: "disabled",
    });
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await expect(dialog.getByRole("checkbox")).not.toBeChecked();
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Remove entry", exact: true })
      .click();
    await expect(
      sheet.getByRole("button", { name: "Actions for storefront-checkout" }),
    ).toHaveCount(0);
    expect(await readProjectRecord(rows[0].path)).toBeUndefined();
    expect(await readProjectRecord(rows[1].path)).toEqual(rows[1].record);
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Keep background polling from removing this filtered row before its explicit Recheck.
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    // Restore the unavailable owner; recheck must adopt its actual status without starting it.
    const project = rows[1].record.projectDirectory;
    await mkdir(project);
    await writeFile(join(project, "index.html"), "Recovered payments preview");
    const runtime = await createPreviewRuntime({ allowedRoots: [project] });
    const started = await runtime.start({
      name: "payments",
      type: "static",
      directory: project,
    });
    await runtime.wait("payments", started.candidate!.id);
    recovered = await startDaemon({
      runtime,
      port: 0,
      tokenFile: join(rows[1].path, "token"),
      owner: {
        projectDirectory: project,
        pid: process.pid,
        allowedRoots: [project],
        allowExec: false,
        inputKeys: [],
        secretIds: [],
      },
    });
    await writeProjectRecord(rows[1].path, {
      ...rows[1].record,
      endpoint: recovered.endpoint,
    });
    await sheet
      .getByRole("button", { name: "Actions for storefront-payments" })
      .click();
    await page.getByRole("menuitem", { name: "Recheck status" }).click();
    await expect(sheet.locator(".preview-nav")).toHaveCount(1);
    await sheet.getByRole("button", { name: "Actions for storefront-payments" }).click();
    await page.getByRole("menuitem", { name: "Remove entry…" }).click();
    await expect(dialog.getByRole("button", { name: "Remove entry", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.locator(".preview-nav").click();
    await expect(page.getByRole("button", { name: "payments", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "payments", exact: true }).click();
    await expect(page.getByRole("article", { name: "Preview details" })).toContainText("Ready");
    await page.clock.resume();
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await sheet.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("combobox", { name: "Filter previews" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Needs attention", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("option", { name: "All statuses", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.locator(".overview-table .preview-name").click();
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(sheet.locator(".preview-nav")).toContainText("Ready");
    await expect(
      sheet.getByRole("button", { name: "Actions for payments" }),
    ).toBeVisible();
    expect(
      await (await fetch((await runtime.get("payments")).url!)).text(),
    ).toBe("Recovered payments preview");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.close();
    await recovered?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
