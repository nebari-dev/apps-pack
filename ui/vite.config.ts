/// <reference types="vitest/config" />

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
