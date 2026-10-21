/// <reference types="vitest/config" />

import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI's own release, bumped by release-please, baked into the bundle (the
// Settings page shows it next to the API's).
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { "import.meta.env.UI_VERSION": JSON.stringify(version) },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Vendor code changes far less often than ours: give it long-lived
        // chunks of its own. Pages are split by the lazy() routes in main.tsx,
        // and keycloak-js by its dynamic import in lib/auth.ts.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
            },
            { name: "query", test: /node_modules[\\/]@tanstack[\\/]/ },
            { name: "icons", test: /node_modules[\\/]lucide-react[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    // Expose vitest globals so @testing-library/react auto-cleans the DOM
    // between tests.
    globals: true,
    setupFiles: "./tests/setup.ts",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    // `npm run test:coverage` (CI) fails below these. They cover the app's own
    // code: components/ui/ is vendored from the @nebari registry and tested
    // there, and main.tsx is boot wiring. Set a little under today's numbers;
    // raise them as tests land.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/components/ui/**", "src/main.tsx"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 80, branches: 70, functions: 75, lines: 81 },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev against a port-forwarded apps-api.
      "/api": {
        target: process.env.API_URL ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
