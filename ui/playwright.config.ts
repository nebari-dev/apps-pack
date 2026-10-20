import { defineConfig, devices } from "@playwright/test";

// End-to-end and accessibility suite (e2e/). It runs against the production
// build served by `vite preview`, so build first (`npm run build`); the
// apps-api is mocked per test in e2e/fixtures.ts.
const port = Number(process.env.PLAYWRIGHT_PORT || 4180);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
