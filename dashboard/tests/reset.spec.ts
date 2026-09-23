import { test, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewSpec } from "../../src/contracts";

const { createPreviewRuntime } = (await import(
  new URL("../../dist/runtime.js", import.meta.url).href
)) as typeof import("../../src/runtime");
const { startDaemon } = (await import(
  new URL("../../dist/daemon.js", import.meta.url).href
)) as typeof import("../../src/daemon");
const { startDashboard } = (await import(
  new URL("../../dist/dashboard.js", import.meta.url).href
)) as typeof import("../../src/dashboard");

test("reset keeps deletion and startup outcomes in context with real PostgreSQL", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.PREVIEWHOST_TEST_DOCKER_SOCKET,
    "Requires disposable local Docker databases",
  );
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "previewhost-reset-ui-"));
  let allowDelete = true;
  let deletionCount = 0;
  let releaseDeletion: (() => void) | undefined;
  const runtime = await createPreviewRuntime({
    allowedRoots: [directory],
    dataDirectory: join(directory, "data"),
    dockerSocket: process.env.PREVIEWHOST_TEST_DOCKER_SOCKET,
    secretIds: ["fixture/api"],
    authorize: async (request) => {
      if (request.operation !== "delete-data") return true;
      deletionCount++;
      if (!allowDelete) return false;
      if (releaseDeletion)
        await new Promise<void>((resolve) => {
          releaseDeletion = resolve;
        });
      return true;
    },
  });
  // Redirect this runtime's unopened store; never access the user's keystore or Keychain.
  Object.defineProperty(runtime.keystore, "directory", {
    value: join(directory, "vault"),
  });
  const password = "FAKE_disposable_reset_password";
  await runtime.keystore.unlock({
    password,
    create: true,
    confirmation: password,
  });
  await runtime.keystore.set(
    "user",
    "fixture/api",
    "FAKE_reset_reference_value",
  );
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    const connection = `import {Client} from ${JSON.stringify(import.meta.resolve("pg"))}; const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();`;
    await writeFile(
      join(directory, "migrate.mjs"),
      connection +
        `import fs from 'node:fs'; if(fs.existsSync('fail-migration')){console.error('Migration failed: deliberate fixture error');process.exit(7);} await db.query('CREATE TABLE IF NOT EXISTS items (id serial primary key, label text)'); await db.end();`,
    );
    await writeFile(
      join(directory, "seed.mjs"),
      connection +
        `await db.query("INSERT INTO items(label) VALUES ('demo')"); await db.end();`,
    );
    await writeFile(
      join(directory, "api.mjs"),
      connection +
        `import http from 'node:http'; http.createServer(async(q,r)=>{try{if(q.method==='POST')await db.query("INSERT INTO items(label) VALUES ('review')");const {rows}=await db.query('SELECT * FROM items ORDER BY id');r.setHeader('content-type','application/json');r.end(JSON.stringify(rows));}catch{r.writeHead(503);r.end('Database unavailable');}}).listen(+process.env.PORT,process.env.HOST);`,
    );
    await writeFile(
      join(directory, "web.mjs"),
      `import http from 'node:http';const html='<!doctype html><title>Review store</title><h1>Review store</h1><button id="add">Add item</button><output></output><script>async function load(method="GET"){document.querySelector("output").textContent=JSON.stringify(await(await fetch("/items",{method})).json())}add.onclick=()=>load("POST");load();</script>';http.createServer(async(q,r)=>{if(q.url==='/items'){const result=await fetch(process.env.API_URL,{method:q.method});r.writeHead(result.status,{'content-type':'application/json'});r.end(await result.text());}else{r.setHeader('content-type','text/html');r.end(html);}}).listen(+process.env.PORT,process.env.HOST);`,
    );
    const spec: PreviewSpec = {
      name: "review-store",
      type: "environment",
      primary: "web",
      services: {
        db: { type: "postgres" },
        migrate: {
          type: "job",
          cwd: directory,
          command: [process.execPath, "migrate.mjs"],
          env: { DATABASE_URL: { service: "db" } },
        },
        seed: {
          type: "job",
          run: "once",
          cwd: directory,
          command: [process.execPath, "seed.mjs"],
          dependsOn: ["migrate"],
          env: { DATABASE_URL: { service: "db" } },
        },
        api: {
          type: "command",
          cwd: directory,
          command: [process.execPath, "api.mjs"],
          dependsOn: ["seed"],
          env: {
            DATABASE_URL: { service: "db" },
            API_SECRET: { secret: "fixture/api" },
          },
        },
        web: {
          type: "command",
          cwd: directory,
          command: [process.execPath, "web.mjs"],
          readyPath: "/items",
          env: { API_URL: { service: "api" } },
        },
      },
    };
    const started = await runtime.start(spec);
    const ready = await runtime.wait(spec.name, started.candidate!.id);
    expect(ready.state).toBe("ready");
    const tokenFile = join(directory, "owner", "token");
    daemon = await startDaemon({
      runtime,
      tokenFile,
      port: 0,
      owner: {
        projectDirectory: directory,
        pid: process.pid,
        allowedRoots: [directory],
        allowExec: true,
        inputKeys: [],
        secretIds: ["fixture/api"],
      },
    });
    let launch = "";
    dashboard = await startDashboard({
      discover: async () => [
        {
          id: "a".repeat(64),
          tokenFile,
          connection: {
            endpoint: daemon!.endpoint,
            pid: process.pid,
            projectDirectory: directory,
          },
        },
      ],
      openBrowser: async (url) => {
        launch = url;
      },
    });
    await dashboard.open();
    await page.goto(launch);
    await page.locator(".overview-table .preview-name").click();
    const app = await context.newPage();
    await app.goto(ready.url!);
    await app.getByRole("button", { name: "Add item" }).click();
    await expect(app.locator("output")).toContainText("review");
    await app.close();
    const reset = async () => {
      await page
        .locator(".header-actions")
        .getByRole("button", { name: "Actions for review-store" })
        .click();
      await page
        .getByRole("menuitem", { name: "Reset data…", exact: true })
        .click();
    };
    await reset();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("db · PostgreSQL");
    await expect(dialog).toContainText(
      "External databases and saved secrets are not deleted.",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(deletionCount).toBe(0);
    allowDelete = false;
    await reset();
    await dialog
      .getByRole("button", { name: "Delete data and start", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: "Delete data and start",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(deletionCount).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "Start preview", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Open app", exact: true }),
    ).toBeVisible();
    const retained = await runtime.get(spec.name);
    expect(await (await fetch(retained.url! + "/items")).json()).toHaveLength(
      2,
    );
    allowDelete = true;
    await writeFile(join(directory, "fail-migration"), "disposable failure");
    releaseDeletion = () => {};
    await reset();
    await dialog
      .getByRole("button", { name: "Delete data and start", exact: true })
      .click();
    await expect(dialog).toContainText("Stopping and deleting managed data…");
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeEnabled();
    await expect.poll(() => deletionCount).toBe(2);
    releaseDeletion();
    releaseDeletion = undefined;
    await expect(dialog).toContainText("Data deleted. Startup failed.");
    await expect(dialog).toContainText("Fix the error, then retry startup.");
    await page.screenshot({ path: "/tmp/previewhost-reset-failed.png" });
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "Data deleted" }),
    ).toHaveCount(0);
    expect(deletionCount).toBe(2);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".attempt-failure")
      .getByRole("button", { name: "Logs", exact: true })
      .click();
    await expect(page.locator(".logs")).toContainText(
      "Migration failed: deliberate fixture error",
    );
    await rm(join(directory, "fail-migration"));
    await page
      .getByRole("button", { name: "Retry start", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Open app", exact: true }),
    ).toBeVisible();
    const recovered = await runtime.get(spec.name);
    expect(await (await fetch(recovered.url! + "/items")).json()).toHaveLength(
      1,
    );
    expect(deletionCount).toBe(2);
    expect(await runtime.keystore.get("user", "fixture/api")).toBe(
      "FAKE_reset_reference_value",
    );
    // A completed mutation with a lost reply is uncertain to the browser, not safe to repeat.
    await page.route("**/api", async (route) => {
      if (route.request().postDataJSON().action === "resetData") {
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await reset();
    await dialog
      .getByRole("button", { name: "Delete data and start", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "The action may have completed. Recheck status",
    );
    await expect(
      dialog.getByRole("button", {
        name: "Delete data and start",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(deletionCount).toBe(3);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Open app", exact: true }),
    ).toBeVisible();
    expect(deletionCount).toBe(3);
  } finally {
    allowDelete = true;
    releaseDeletion?.();
    releaseDeletion = undefined;
    await dashboard?.close();
    for (const preview of await runtime.list()) {
      await runtime.stop(preview.name);
      if (preview.data) await runtime.deleteData(preview.name);
    }
    await daemon?.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
