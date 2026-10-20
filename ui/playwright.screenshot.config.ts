import { defineConfig, devices } from "@playwright/test";

// Regenerates the README / docs screenshot (`npm run screenshot`). Kept apart
// from playwright.config.ts so `npm run test:e2e` never collects it. Like the
// e2e suite it runs the production build under `vite preview` (build first)
// with the apps-api mocked by e2e/fixtures.ts.
const port = Number(process.env.PLAYWRIGHT_PORT || 4181);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./scripts",
  testMatch: "readme-screenshot.ts",
  outputDir: "./test-results/screenshot",
  reporter: "list",
  use: { baseURL },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 680 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
