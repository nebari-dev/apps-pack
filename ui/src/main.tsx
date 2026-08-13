import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { ThemeProvider } from '@/hooks/theme-provider';
import { initAuth } from '@/lib/auth';
import { AppDetailPage } from '@/pages/app-detail';
import { AppsPage } from '@/pages/apps';
import { DashboardPage } from '@/pages/dashboard';
import { EditPage } from '@/pages/edit';
import { LaunchPage } from '@/pages/launch';
import { MetricsPage } from '@/pages/metrics';
import { Toaster } from '@/ui/toast';
import '@/index.css';

// Initialize auth (and the Keycloak redirect dance) before rendering.
await initAuth();

// localStorage key for the theme preference. Must stay in sync with the
// pre-paint bootstrap script inlined in index.html.
const THEME_STORAGE_KEY = 'nebari-apps:themeMode';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchInterval: 10_000, staleTime: 5_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider storageKey={THEME_STORAGE_KEY}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="apps" element={<AppsPage />} />
              <Route path="apps/:namespace/:name" element={<AppDetailPage />} />
              <Route path="apps/:namespace/:name/edit" element={<EditPage />} />
              <Route path="metrics" element={<MetricsPage />} />
              <Route path="launch" element={<LaunchPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
