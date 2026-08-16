import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const todoPluginFixtureAvailable = existsSync(resolve(import.meta.dirname, "../../todo-list-plugin/dist/mf-manifest.json"));

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error(`[browser page error] ${error.stack ?? error.message}`));
});

async function connectWithPat(page: Page): Promise<void> {
  await page.getByTestId("connect-button").click();
  const dialog = page.getByTestId("connect-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("token-input").fill("github_pat_fake_e2e_token");
  await dialog.getByTestId("connect-submit").click();
  await expect(page.getByTestId("mode-indicator")).not.toContainText(/demo/i);
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);
}

async function connectWithSharedPat(page: Page): Promise<void> {
  await page.getByTestId("connect-button").click();
  const dialog = page.getByTestId("connect-dialog");
  await dialog.getByTestId("token-input").fill("github_pat_fake_shared_plugin_e2e_token");
  await dialog.getByTestId("share-credential").check();
  await dialog.getByRole("checkbox", { name: /understand the browser-storage risk/i }).check();
  await dialog.getByTestId("connect-submit").click();
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);
}

async function loadTodoPlugin(page: Page): Promise<void> {
  await page.getByTestId("todo-plugin-load").click();
  await expect(page.getByTestId("todo-plugin-status")).toContainText(/loaded private plugin/i);
  await expect(page.getByRole("heading", { name: "Small steps, clearly held." })).toBeVisible();
}

test("connects, edits and publishes through the fake self repository", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByTestId("mode-indicator")).toContainText(/demo/i);
  await expect(page.getByTestId("record-list")).toBeVisible();

  await connectWithPat(page);
  await page.getByTestId("new-record-button").click();

  await page.getByTestId("record-title").fill("Playwright happy path");
  await page
    .getByTestId("record-editor")
    .fill("Saved through the deterministic fake repository adapter.");
  await page.getByTestId("save-button").click();

  await expect(page.getByTestId("sync-status")).toContainText(/committed|building|published/i);
  await expect(page.getByTestId("sync-status")).toContainText(/published/i);
  await expect(page.getByTestId("record-list")).toContainText("Playwright happy path");
  await expect(page.getByTestId("conflict-panel")).toBeHidden();
});

test("authorises through deterministic fake Device Flow", async ({ page }) => {
  await page.goto("./");
  await page.getByTestId("connect-button").click();
  await page.getByTestId("auth-method-device").click();

  await expect(page.getByTestId("device-flow-panel")).toBeVisible();
  await page.getByTestId("device-start").click();

  await expect(page.getByTestId("device-user-code")).toHaveText("LUNA-2026");
  await expect(page.getByTestId("device-verification-link")).toHaveAttribute(
    "href",
    /github\.com\/login\/device/,
  );
  await expect(page.getByTestId("mode-indicator")).not.toContainText(/demo/i);
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);
});

test("shares a PAT after first-use opt-in and restores it on reload", async ({ page }) => {
  await page.goto("./");
  await page.getByTestId("connect-button").click();
  const dialog = page.getByTestId("connect-dialog");
  await dialog.getByTestId("token-input").fill("github_pat_fake_shared_e2e_token");
  await dialog.getByTestId("share-credential").check();
  await dialog.getByRole("checkbox", { name: /understand the browser-storage risk/i }).check();
  await dialog.getByTestId("connect-submit").click();
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);

  await page.reload();
  await expect(page.getByTestId("mode-indicator")).not.toContainText(/demo/i);
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);

  await page.getByTestId("connect-button").click();
  await page.getByTestId("disconnect-session").click();
  await expect(page.getByTestId("mode-indicator")).toContainText(/demo/i);

  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("use-shared-credential")).toBeVisible();
  await page.getByTestId("use-shared-credential").click();
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);

  await page.getByTestId("connect-button").click();
  await page.getByTestId("remove-shared-credential").click();
  await expect(page.getByTestId("mode-indicator")).toContainText(/demo/i);
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("use-shared-credential")).toBeHidden();
});

test("restores an app-specific persistent PAT after reload", async ({ page }) => {
  await page.goto("./");
  await page.getByTestId("connect-button").click();
  const dialog = page.getByTestId("connect-dialog");
  await dialog.getByRole("radio", { name: /this browser/i }).check();
  await dialog.getByRole("checkbox", { name: /understand the browser-storage risk/i }).check();
  await dialog.getByTestId("token-input").fill("github_pat_fake_persistent_e2e_token");
  await dialog.getByTestId("connect-submit").click();
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);

  await page.reload();

  await expect(page.getByTestId("mode-indicator")).not.toContainText(/demo/i);
  await expect(page.getByTestId("sync-status")).toContainText(/ready/i);
});

test("deletes a record through a revision-aware fake commit", async ({ page }) => {
  await page.goto("./");
  await connectWithPat(page);
  await expect(page.getByTestId("record-list")).toContainText("Morning walk");

  await page.getByTestId("delete-record-button").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete").click();

  await expect(page.getByTestId("record-list")).not.toContainText("Morning walk");
  await expect(page.getByTestId("sync-status")).toContainText(/committed|building|published/i);
  await expect(page.getByTestId("sync-status")).toContainText(/published/i);
  await expect(page.getByTestId("conflict-panel")).toBeHidden();
});

test("keeps an offline edit as a recoverable local draft without committing", async ({ context, page }) => {
  await page.goto("./");
  await connectWithPat(page);
  await page.getByTestId("new-record-button").click();
  await page.getByTestId("record-title").fill("Offline field note");
  await page.getByTestId("record-editor").fill("This should stay in IndexedDB until I reconnect.");

  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("sync-status")).toContainText(/offline draft saved/i);
  await expect(page.getByTestId("record-list")).not.toContainText("Offline field note");

  await context.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("draft-recovery")).toBeVisible();
  await page.locator("[data-draft-restore]").click();
  await expect(page.getByTestId("record-title")).toHaveValue("Offline field note");
  await expect(page.getByTestId("record-editor")).toHaveValue(
    "This should stay in IndexedDB until I reconnect.",
  );
});

test("loads the private Todo federation graph through the project-base Service Worker", async ({ page }) => {
  test.skip(!todoPluginFixtureAvailable, "The private sibling plugin fixture is not available in this checkout.");
  await page.goto("./");

  await expect(page.getByTestId("todo-plugin-status")).toContainText(/not been requested/i);
  await connectWithSharedPat(page);
  await loadTodoPlugin(page);

  await expect(page.getByText("Review the private plugin boundary")).toBeVisible();
  await expect(page.getByLabel("Task summary")).toContainText("2 active");

  const virtualResources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("/__plugins/")));
  expect(virtualResources.some((url) => url.includes("/quick-log/__plugins/todo-list/"))).toBe(true);
  expect(virtualResources.join(" ")).not.toContain("github_pat_fake_shared_plugin_e2e_token");

  const deleteButtons = page.locator(".todo-plugin-shell").getByRole("button", { name: /^Delete / });
  while (await deleteButtons.count()) await deleteButtons.first().click();
  await expect(page.getByRole("heading", { name: "No tasks in this view" })).toBeVisible();
  await expect(page.locator(".todo-plugin-shell .empty-state img")).toHaveJSProperty("complete", true);

  await page.getByTestId("todo-plugin-disconnect").click();
  await expect(page.getByTestId("todo-plugin-status")).toContainText(/cache were cleared/i);
  const cacheKeys = await page.evaluate(() => caches.keys());
  expect(cacheKeys.filter((key) => key.startsWith("private-plugin:todo-list"))).toEqual([]);
  const anonymousStatus = await page.evaluate(async () => {
    const config = JSON.parse(document.getElementById("todo-plugin-config")?.textContent ?? "{}");
    return fetch(new URL(`__plugins/todo-list/${config.commitSha}/mf-manifest.json`, document.baseURI)).then((response) => response.status);
  });
  expect(anonymousStatus).toBe(401);
});

test("syncs Todo state across devices and rejects a stale device write", async ({ browser }) => {
  test.skip(!todoPluginFixtureAvailable, "The private sibling plugin fixture is not available in this checkout.");
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await Promise.all([first.goto("./"), second.goto("./")]);
    await Promise.all([connectWithSharedPat(first), connectWithSharedPat(second)]);
    await Promise.all([loadTodoPlugin(first), loadTodoPlugin(second)]);

    const firstEditor = first.locator("form[aria-label='Create task']");
    await firstEditor.getByLabel("Title").fill("Retrieve this task on another device");
    await firstEditor.getByLabel("Description").fill("Canonical state is stored in the fixed private Todo data repository.");
    await firstEditor.getByRole("button", { name: "Add task" }).click();
    await first.getByRole("button", { name: "Save changes" }).click();
    await expect(first.getByText(/Committed [0-9a-f]{7}/)).toBeVisible();

    await second.getByRole("button", { name: "Complete Plan the next small release" }).click();
    await second.getByRole("button", { name: "Save changes" }).click();
    await expect(second.getByText(/remote snapshot changed/i)).toBeVisible();
    await second.getByRole("button", { name: "Reload host snapshot" }).click();
    await expect(second.getByText("Retrieve this task on another device")).toBeVisible();
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
