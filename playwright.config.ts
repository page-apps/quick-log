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
    baseURL: "http://127.0.0.1:4324/quick-log/",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  ...(process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1" ? {} : { webServer: {
    command: "node e2e/serve.mjs",
    port: 4324,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "repo-apps-test/quick-log",
      PUBLIC_REPO_APPS_FAKE: "1",
      PUBLIC_REPO_OWNER: "repo-apps-test",
      PUBLIC_REPO_NAME: "quick-log",
      PUBLIC_REPO_BRANCH: "main",
      PUBLIC_APP_VERSION: "e2e",
      PUBLIC_COMMIT_SHA: "0000000000000000000000000000000000000000",
      PUBLIC_GITHUB_DEVICE_CLIENT_ID: "quick-log-fake-client",
      PUBLIC_TODO_PLUGIN_SHA: "1542da707d725331ec9d73cedb6ff2af272ea0f5",
    },
  } }),
});
