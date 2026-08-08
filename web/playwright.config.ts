import { defineConfig, devices } from "@playwright/test";

const externalUrl = process.env.AGENT_TEAM_WEB_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "../.agent-team/playwright",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: externalUrl ?? "http://127.0.0.1:4399",
    trace: "retain-on-failure",
  },
  webServer: externalUrl
    ? undefined
    : {
        command: "tsx e2e/fixture-server.ts",
        url: "http://127.0.0.1:4399/api/health",
        reuseExistingServer: false,
        timeout: 15_000,
      },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
