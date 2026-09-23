import { test, expect } from "@playwright/test";
import { mock } from "node:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { state, type Entry } from "../src/lib/model";

const { createPreviewRuntime } = await import(new URL("../../dist/runtime.js", import.meta.url).href) as typeof import("../../src/runtime");
const { startDaemon } = await import(new URL("../../dist/daemon.js", import.meta.url).href) as typeof import("../../src/daemon");
const { startDashboard } = await import(new URL("../../dist/dashboard.js", import.meta.url).href) as typeof import("../../src/dashboard");
const { connectPreviewDaemon } = await import(new URL("../../dist/client.js", import.meta.url).href) as typeof import("../../src/client");
const { SecretSetup } = await import(new URL("../../dist/secrets-setup.js", import.meta.url).href) as typeof import("../../src/secrets-setup");
const { keychain } = await import(new URL("../../dist/keychain.js", import.meta.url).href) as typeof import("../../src/keychain");

test("private setup and dashboard preserve unlock, approval and update boundaries", async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), "previewhost-browser-keystore-"));
  const originalHome = process.env.HOME;
  const originalGet = keychain.get, originalAdd = keychain.add, originalRemove = keychain.remove;
  const originalBrowser = SecretSetup.prototype.openBrowser;
  const password = "FAKE_browser_password";
  let privateUrl = "", dashboardUrl = "";
  let runtime: Awaited<ReturnType<typeof createPreviewRuntime>> | undefined;
  let other: Awaited<ReturnType<typeof createPreviewRuntime>> | undefined;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let client: ReturnType<typeof connectPreviewDaemon> | undefined;
  const errors: string[] = [];
  const setup = await context.newPage();
  for (const tab of [page, setup]) tab.on("pageerror", error => errors.push(error.message));
  try {
    // All storage is disposable. Never read or modify the user's Keychain.
    process.env.HOME = directory;
    keychain.get = async () => undefined;
    keychain.remove = async () => {};
    keychain.add = async () => { throw new Error("OS storage unavailable"); };
    SecretSetup.prototype.openBrowser = async url => { privateUrl = url; };
    const project = join(directory, "project"); await mkdir(project);
    await writeFile(join(project, "app.mjs"), `import http from 'node:http';http.createServer((q,s)=>s.end(process.env.APP_TOKEN)).listen(Number(process.env.PORT),'127.0.0.1');`);
    runtime = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
    other = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
    const tokenFile = join(directory, "control", "token");
    daemon = await startDaemon({ runtime, tokenFile, port: 0, owner: {
      projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [],
    } });
    client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
    const discover = async () => [{
      id: createHash("sha256").update(project).digest("hex"), tokenFile,
      connection: { endpoint: daemon!.endpoint, pid: process.pid, projectDirectory: project },
    }];
    dashboard = await startDashboard({ discover, openBrowser: async url => { dashboardUrl = url; } });
    await dashboard.open();
    await page.goto(dashboardUrl);
    await page.getByRole("button", { name: "Secret Manager", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create your keystore" })).toBeVisible();
    await page.getByLabel("Keystore password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill("FAKE_mismatch");
    await page.getByRole("button", { name: "Create keystore", exact: true }).click();
    await expect(page.getByText("Use at least 12 characters and enter the same password twice.")).toBeVisible();
    await expect(page.getByLabel("Keystore password", { exact: true })).toHaveValue("");
    await page.getByLabel("Keystore password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    if (process.platform === "darwin") await page.getByLabel("Remember unlock on this Mac").check();
    await page.getByRole("button", { name: "Create keystore", exact: true }).click();
    await expect(page.getByText("No stored secrets", { exact: true })).toBeVisible();
    if (process.platform === "darwin") await expect(page.getByText(/Automatic unlock could not be confirmed/)).toBeVisible();
    expect((await runtime.keystore.status()).state).toBe("locked");

    const spec = { name: "sample", type: "command" as const, cwd: project, command: [process.execPath, "app.mjs"], env: { APP_TOKEN: { secret: "project/dev/token" } } };
    const expired = await client.secretsSetup(spec);
    const expiredUrl = privateUrl;
    const clock = mock.method(Date, "now", () => Date.parse(expired.expiresAt) + 1);
    try { expect((await client.secretsStatus(expired.id)).state).toBe("expired"); }
    finally { clock.mock.restore(); }
    await setup.goto(expiredUrl);
    await expect(setup.getByRole("heading", { name: "Private setup unavailable" })).toBeVisible();
    expect((await runtime.inspect(spec)).secrets![0].selected).toBe(false);
    // Browser launches have a one-second rate limit, independent of expiry.
    await delay(1001);
    const request = await client.secretsSetup(spec);
    expect(request.id).not.toBe(expired.id);
    await setup.goto("about:blank");
    await setup.goto(privateUrl);
    await expect(setup.getByRole("heading", { name: "Allow these secret names?" })).toBeVisible();
    await expect(setup.locator("#fields")).toContainText("APP_TOKEN");
    await expect(setup.locator("#fields")).toContainText("project/dev/token");
    await setup.getByRole("button", { name: "Allow names", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Unlock your keystore" })).toBeVisible();
    await setup.setViewportSize({ width: 320, height: 800 });
    expect(await setup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await setup.screenshot({ path: "/tmp/previewhost-private-unlock.png" });
    await setup.getByLabel("Keystore password", { exact: true }).fill("FAKE_wrong");
    await setup.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(setup.getByText(/password is incorrect or the keystore is damaged/)).toBeVisible();
    await expect(setup.getByLabel("Keystore password", { exact: true })).toHaveValue("");
    await setup.getByLabel("Keystore password", { exact: true }).fill(password);
    await setup.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Add missing secrets" })).toBeVisible();
    await setup.getByLabel("project/dev/token", { exact: true }).fill("FAKE_original");
    await setup.getByRole("button", { name: "Save secrets", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Secret setup complete" })).toBeVisible();
    expect((await client.secretsStatus(request.id)).state).toBe("complete");
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    expect(await runtime.list()).toEqual([]);
    expect((await client.secretsStatus(expired.id)).state).toBe("expired");
    await expect(page.locator(".preview-nav")).toHaveCount(1);
    await page.locator(".preview-nav").filter({ hasText: "sample" }).click();
    const privateSetup = page.locator("section").filter({ has: page.getByRole("heading", { name: "Private setup", exact: true }) });
    await expect(privateSetup.getByText("Latest request: Complete", { exact: true })).toBeVisible();
    await expect(privateSetup.getByText("Expired", { exact: true })).toHaveCount(0);
    await expect(privateSetup).not.toContainText("Request history");
    await expect(privateSetup).not.toContainText("request any remaining values");
    expect((await other.keystore.status()).state).toBe("locked");
    expect((await other.inspect(spec)).secrets![0].selected).toBe(false);
    const started = await runtime.start(spec);
    const ready = await runtime.wait(spec.name, started.candidate!.id);
    expect(ready.state).toBe("ready");
    expect(await (await fetch(ready.url!)).text()).toBe("FAKE_original");
    await expect(page.getByRole("link", { name: "Open app", exact: true })).toBeVisible();
    await expect(privateSetup).not.toContainText("Secrets saved");
    await expect(privateSetup.getByText("Latest request: Complete", { exact: true })).toBeVisible();
    // A later completed request must not hide a different form that still needs approval.
    const extra = { ...spec, env: { EXTRA: { secret: "project/dev/extra" } } };
    const pending = await client.secretsSetup(extra);
    expect((await client.secretsSetup(spec)).state).toBe("complete");
    await expect(privateSetup.getByText("Awaiting approval or entry", { exact: true })).toBeVisible();
    await expect(privateSetup.getByText("Latest request: Complete", { exact: true })).toHaveCount(0);
    expect((await client.secretsStatus(pending.id)).state).toBe("pending");
    expect((await runtime.inspect(extra)).secrets![0].selected).toBe(false);
    await setup.goto("about:blank");
    await setup.goto(privateUrl);
    await setup.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Secret setup canceled" })).toBeVisible();
    expect((await client.secretsStatus(pending.id)).state).toBe("canceled");
    await expect(privateSetup.getByText("Latest request: Complete", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Secret Manager", exact: true }).click();

    const edit = page.getByRole("button", { name: "Edit project/dev/token", exact: true });
    await expect(edit).toBeVisible(); await edit.click();
    await expect(page.getByLabel("New value", { exact: true })).toBeFocused();
    await expect(page.getByLabel("New value", { exact: true })).toHaveValue("");
    await page.keyboard.press("Escape"); await expect(edit).toBeFocused(); await edit.click();
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("dialog").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: "/tmp/previewhost-secret-edit.png" });
    await page.getByLabel("New value", { exact: true }).fill("FAKE_updated");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await (await fetch(ready.url!)).text()).toBe("FAKE_original");
    const replaced = await runtime.replace(spec.name, spec);
    const updated = await runtime.wait(spec.name, replaced.candidate!.id);
    expect(updated.state).toBe("ready");
    expect(await (await fetch(updated.url!)).text()).toBe("FAKE_updated");
    await page.setViewportSize({ width: 1360, height: 900 });
    if (process.platform === "darwin") {
      await page.getByRole("button", { name: "Forget automatic unlock", exact: true }).click();
      await expect(page.getByText(/Already unlocked sessions remain unlocked/)).toBeVisible();
    }
    // Restart the dashboard: its key was not persisted, and owners remain independent.
    await dashboard.close();
    dashboard = await startDashboard({ discover: async () => [], openBrowser: async url => { dashboardUrl = url; } });
    await dashboard.open(); await page.goto(dashboardUrl);
    await page.getByRole("button", { name: "Secret Manager", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Unlock your keystore" })).toBeVisible();
    await page.getByLabel("Keystore password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(edit).toBeVisible();
    await page.screenshot({ path: "/tmp/previewhost-keystore-desktop.png" });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(page.locator(".secret-row code")).toHaveCSS("color", "rgb(237, 237, 237)");
    await page.screenshot({ path: "/tmp/previewhost-keystore-narrow-dark.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await client?.close(); await dashboard?.close(); await daemon?.close();
    await runtime?.close(); await other?.close();
    keychain.get = originalGet; keychain.add = originalAdd; keychain.remove = originalRemove; SecretSetup.prototype.openBrowser = originalBrowser;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later completed setup does not keep an old cancellation in the preview status", () => {
  const canceled = { id: "first", name: "sample", mode: "missing" as const, state: "canceled" as const,
    browser: "opened" as const, expiresAt: "2026-01-01T00:05:00Z" };
  const entry: Entry = { name: "sample", owner: { id: "owner", requests: [canceled] } };
  expect(state(entry).note).toBe("Private setup canceled");
  entry.owner.requests!.push({ ...canceled, id: "second", state: "complete" });
  expect(state(entry)).toEqual({ label: "Not started", tone: "muted", note: "" });
  entry.owner.requests!.push({ ...canceled, id: "third" });
  expect(state(entry).note).toBe("Private setup canceled");
});

test("Secret Manager searches all references and keeps bounded pages usable after edits", async ({ page }) => {
  const { Keystore } = await import(new URL("../../dist/keystore.js", import.meta.url).href) as typeof import("../../src/keystore");
  const directory = await mkdtemp(join(tmpdir(), "previewhost-secret-pages-"));
  const originalGet = keychain.get;
  const password = "FAKE_pagination_password";
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let launch = "";
  const vault = join(directory, "vault");
  const store = new Keystore(vault);
  const prototype = Keystore.prototype as unknown as { open: (this: InstanceType<typeof Keystore>) => unknown };
  const originalOpen = prototype.open;
  // Redirect only storage location; encryption, locking and private password entry stay real.
  const redirected = mock.method(prototype, "open", function (this: InstanceType<typeof Keystore>) {
    Object.defineProperty(this, "directory", { value: vault, configurable: true });
    return originalOpen.call(this);
  });
  const names = Array.from({ length: 130 }, (_, index) => `disposable/worktree/api-token-${String(index).padStart(3, "0")}`);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    keychain.get = async () => undefined;
    await store.unlock({ password, confirmation: password, create: true });
    for (const id of names) await store.set("user", id, "FAKE_original");
    dashboard = await startDashboard({ discover: async () => [], openBrowser: async url => { launch = url; } });
    await dashboard.open(); await page.goto(launch);
    await page.getByRole("button", { name: "Secret Manager", exact: true }).click();
    await page.getByLabel("Keystore password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    const rows = page.locator(".secret-row");
    const next = page.getByRole("button", { name: "Next", exact: true });
    const previous = page.getByRole("button", { name: "Previous", exact: true });
    const search = page.getByRole("searchbox", { name: "Search references" });
    await expect(rows).toHaveCount(128);
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    await next.focus(); await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(names[128]);
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(rows).toHaveCount(128);
    await expect(next).toBeEnabled();
    await page.route("**/api", route => {
      const request = route.request().postDataJSON();
      if (request.action === "listSecrets" && request.after) return route.fulfill({
        status: 500, json: { error: { code: "SECRET_STORE_UNAVAILABLE", message: "Listing interrupted. Retry." } },
      });
      return route.continue();
    });
    await next.click();
    await expect(page.getByText("Secrets unavailable", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
    await expect(page.locator(".secret-count")).toHaveText("");
    await expect(search).toBeEnabled();
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await page.unroute("**/api");
    await previous.click();
    await expect(page.getByText("Secrets unavailable", { exact: true })).toHaveCount(0);
    await expect(rows).toHaveCount(128);
    // Search must find an entry outside the initial page and retain the input after empty results.
    await search.fill("DOES-NOT-EXIST");
    await expect(page.getByText("No matching references", { exact: true })).toBeVisible();
    await expect(search).toBeFocused();
    await search.fill("API-TOKEN-129");
    const edit = page.getByRole("button", { name: `Edit ${names[129]}`, exact: true });
    await expect(rows).toHaveCount(1); await edit.click();
    await expect(page.getByLabel("New value", { exact: true })).toHaveValue("");
    await page.getByLabel("New value", { exact: true }).fill("FAKE_updated");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(edit).toBeFocused();
    expect(await store.get("user", names[129])).toBe("FAKE_updated");
    expect(await store.get("user", names[128])).toBe("FAKE_original");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(search).toHaveValue("API-TOKEN-129");
    await expect(rows).toHaveCount(1);
    expect(await page.locator("body").innerText()).not.toContain("FAKE_");
    await search.fill("");
    await expect(rows).toHaveCount(128);
    await page.locator('[data-sonner-toast] [data-close-button]').click();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await page.screenshot({ path: "/tmp/previewhost-secret-pages-light.png" });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(next).toBeInViewport();
    await expect(rows.first().locator("code")).toHaveCSS("color", "rgb(237, 237, 237)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const scroll = page.locator('.secret-scroll [data-slot="scroll-area-viewport"]');
    expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.screenshot({ path: "/tmp/previewhost-secret-pages-narrow-dark.png" });
    await next.click();
    await expect(rows).toHaveCount(2);
    await store.remove("user", names[128]); await store.remove("user", names[129]);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("No more references", { exact: true })).toBeVisible();
    await previous.click();
    await expect(rows).toHaveCount(128);
    expect(errors).toEqual([]);
  } finally {
    await dashboard?.close(); store.close();
    keychain.get = originalGet;
    redirected.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
});
