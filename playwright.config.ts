import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    baseURL: "http://127.0.0.1:4324",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node e2e/serve.mjs",
    url: "http://127.0.0.1:4324",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      GITHUB_ACTIONS: "false",
      PUBLIC_REPO_APPS_FAKE: "1",
      PUBLIC_REPO_OWNER: "repo-apps-test",
      PUBLIC_REPO_NAME: "quick-log",
      PUBLIC_REPO_BRANCH: "main",
      PUBLIC_APP_VERSION: "e2e",
      PUBLIC_COMMIT_SHA: "0000000000000000000000000000000000000000",
      PUBLIC_GITHUB_DEVICE_CLIENT_ID: "quick-log-fake-client",
    },
  },
});
