import { test, expect } from "@playwright/test";
import { mock } from "node:test";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const { createPreviewRuntime } = await import(new URL("../../dist/runtime.js", import.meta.url).href) as typeof import("../../src/runtime");
const { startDaemon } = await import(new URL("../../dist/daemon.js", import.meta.url).href) as typeof import("../../src/daemon");
const { startDashboard } = await import(new URL("../../dist/dashboard.js", import.meta.url).href) as typeof import("../../src/dashboard");
const { Keystore } = await import(new URL("../../dist/keystore.js", import.meta.url).href) as typeof import("../../src/keystore");
const { keychain } = await import(new URL("../../dist/keychain.js", import.meta.url).href) as typeof import("../../src/keychain");

test("variable sources use eligible services and reference browsing never grants access", async ({ page }) => {
  const directory = await mkdtemp(join(os.tmpdir(), "previewhost-bindings-"));
  const home = mock.method(os, "homedir", () => directory);
  syncBuiltinESMExports();
  const key = mock.method(keychain, "get", async () => undefined);
  const store = new Keystore();
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "index.html"), "Existing preview");
  const password = "FAKE_binding_password";
  await store.unlock({ create: true, password, confirmation: password });
  const refs = Array.from({ length: 130 }, (_, index) => `project/dev/token-${String(index).padStart(3, "0")}`);
  for (const id of refs) await store.add("user", id, "FAKE_private_value");
  const runtime = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
  const started = await runtime.start({ name: "sample", type: "static", directory: project });
  await runtime.wait("sample", started.candidate!.id);
  // Inspect a saved configuration without applying it or starting its database/job.
  const recipe = JSON.stringify({ name: "sample", type: "environment", primary: "web", services: {
    api: { type: "command", cwd: ".", command: [process.execPath, "server.mjs"] },
    web: { type: "static", directory: "." },
    db: { type: "postgres" },
    migrate: { type: "job", cwd: ".", command: [process.execPath, "migrate.mjs"] },
  } });
  await writeFile(join(project, "preview.yaml"), recipe);
  const tokenFile = join(directory, "control/token");
  const daemon = await startDaemon({ runtime, tokenFile, port: 0, owner: {
    projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [],
  } });
  let launch = "";
  const dashboard = await startDashboard({ discover: async () => [{
    id: createHash("sha256").update(project).digest("hex"), tokenFile,
    connection: { endpoint: daemon.endpoint, pid: process.pid, projectDirectory: project },
  }], openBrowser: async url => { launch = url; } });
  const actions: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/api")) actions.push(request.postDataJSON().action); });
  try {
    await dashboard.open(); await page.goto(launch);
    await page.getByRole("button", { name: "Secret Manager", exact: true }).click();
    await page.getByLabel("Keystore password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.locator(".secret-row")).toHaveCount(128);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".overview-table .preview-name").click();
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("combobox", { name: "Configuration source" }).click();
    await page.getByRole("option", { name: "Project configuration file", exact: true }).click();
    await page.getByRole("button", { name: "Add variable", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Add variable", exact: true });
    await editor.getByLabel("Variable name", { exact: true }).fill("API_URL");
    async function source(name: string) {
      await editor.getByRole("combobox", { name: "Value source" }).click();
      await page.getByRole("option", { name, exact: true }).click();
    }
    await source("Service URL");
    await editor.getByRole("combobox", { name: "Service", exact: true }).click();
    await expect(page.getByRole("option")).toHaveText(["web", "db"]);
    await page.getByRole("option", { name: "db", exact: true }).click();
    await source("Browser URL");
    await editor.getByRole("combobox", { name: "Service", exact: true }).click();
    await expect(page.getByRole("option")).toHaveText(["api", "web"]);
    await page.getByRole("option", { name: "api", exact: true }).click();
    await source("Application URL");
    await expect(editor.getByLabel("Primary service", { exact: true })).toHaveValue("web");
    await expect(editor.getByLabel("Primary service", { exact: true })).toHaveAttribute("readonly", "");
    await source("Secret");
    const reference = editor.getByLabel("Secret reference", { exact: true });
    await reference.click();
    const picker = page.locator('[data-slot="popover-content"]');
    const search = picker.getByRole("textbox", { name: "Search or enter a reference" });
    await expect(picker.locator(".reference-option")).toHaveCount(128);
    await picker.getByRole("button", { name: "Next", exact: true }).press("Enter");
    await expect(search).toBeFocused();
    await expect(picker.locator(".reference-option")).toHaveCount(2);
    await search.fill("token-129");
    await expect(picker.getByRole("button", { name: refs[129], exact: true })).toBeVisible();
    await search.press("ArrowDown"); await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(editor.getByLabel("Secret reference", { exact: true })).toBeFocused();
    await editor.getByLabel("Secret reference", { exact: true }).click();
    await search.fill("project/dev/new-token");
    await picker.getByRole("button", { name: "Use “project/dev/new-token”", exact: true }).click();
    await expect(editor.getByLabel("Secret reference", { exact: true })).toHaveText("project/dev/new-token");
    await editor.getByRole("button", { name: "Keep change", exact: true }).click();
    await expect(page.locator(".editable-env-table")).toContainText("project/dev/new-token");
    expect(actions).not.toContain("previewSecrets");
    expect(actions).not.toContain("createSecret");
    expect(actions).not.toContain("previewLaunch");
    expect(await store.has("user", "project/dev/new-token")).toBe(false);
    expect((await runtime.get("sample")).active!.id).toBe(started.candidate!.id);
    expect(await readFile(join(project, "preview.yaml"), "utf8")).toBe(recipe);
    expect(await page.locator("body").innerText()).not.toContain("FAKE_private_value");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.close(); await daemon.close(); await runtime.close(); store.close();
    key.mock.restore(); home.mock.restore(); syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});
