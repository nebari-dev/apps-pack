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
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // The overflow checks are about narrow screens; the desktop run skips them.
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      // Phone width (an iPhone 13's 390x844 viewport) in Chromium, so CI still
      // installs one browser. Runs the axe suite and the overflow checks.
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
      testMatch: /(a11y|responsive)\.spec\.ts/,
    },
  ],
});
