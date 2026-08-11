import { defineConfig, devices } from "@playwright/test";
import { E2E_SESSION_TOKEN, e2eSessionCookieName } from "./e2e/session.js";

const externalUrl = process.env.AGENT_TEAM_WEB_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "../.agent-team/playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: externalUrl ?? "http://127.0.0.1:4399",
    trace: "retain-on-failure",
    storageState: externalUrl ? undefined : {
      cookies: [{
        name: e2eSessionCookieName(),
        value: E2E_SESSION_TOKEN,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      }],
      origins: [],
    },
  },
  webServer: externalUrl
    ? undefined
    : {
        command: "pnpm --dir .. exec tsx web/e2e/fixture-server.ts",
        url: "http://127.0.0.1:4399/",
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
