import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentType, lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/layout";
import { Toaster } from "@/components/ui/toast";
import { ThemeProvider } from "@/hooks/theme-provider";
import { initAuth } from "@/lib/auth";
import { applyBranding, loadBranding } from "@/lib/branding";
import { NotFoundPage } from "@/pages/not-found";
import "@/index.css";

// A tab opened before an upgrade asks for page chunks the new image no longer
// serves. Reload once to pick up the new index.html; if that fails too, let the
// error boundary show it rather than reloading in a loop.
const CHUNK_RELOAD_KEY = "nebari-apps:chunkReload";
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// One chunk per page, fetched on first visit (Layout suspends while it loads).
// A page chunk that loads re-arms the reload above.
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(async () => {
    const mod = await load();
    // The handler above cancelled a failed load and is reloading the page:
    // Vite resolves the import with nothing. Wait for the reload.
    if (!mod) return new Promise<never>(() => {});
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    } catch {
      // Storage blocked: the reload guard is off too.
    }
    return { default: mod[name] };
  });
}
const AppDetailPage = page(() => import("@/pages/app-detail"), "AppDetailPage");
const AppsPage = page(() => import("@/pages/apps"), "AppsPage");
const EditPage = page(() => import("@/pages/edit"), "EditPage");
const LaunchPage = page(() => import("@/pages/launch"), "LaunchPage");

// Branding comes from /config.json (ui.branding.* in the chart). Start the
// fetch before the auth round trip so the two overlap, and treat it as
// best-effort: a missing or malformed config leaves the built-in Nebari
// defaults in place rather than blocking the app from booting.
const brandingReady = loadBranding().catch(() => null);

// Initialize auth (and the Keycloak redirect dance) before rendering.
await initAuth();

// Apply the document-level branding - title, favicon, theme tokens - before the
// first paint. Logos and banners are applied by the components that use them.
const branding = await brandingReady;
if (branding) {
  applyBranding(branding);
}

// localStorage key for the theme preference. Must stay in sync with the
// pre-paint bootstrap script inlined in index.html.
const THEME_STORAGE_KEY = "nebari-apps:themeMode";

const queryClient = new QueryClient({
  defaultOptions: {
    // No global refetchInterval: queries showing live state poll via lib/polling.
    queries: { retry: 1, staleTime: 5_000 },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing the #root element");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider storageKey={THEME_STORAGE_KEY}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              {/* The apps list is the home page. */}
              <Route index element={<Navigate to="/apps" replace />} />
              <Route path="apps" element={<AppsPage />} />
              <Route path="apps/:namespace/:name" element={<AppDetailPage />} />
              <Route path="apps/:namespace/:name/edit" element={<EditPage />} />
              <Route path="launch" element={<LaunchPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
