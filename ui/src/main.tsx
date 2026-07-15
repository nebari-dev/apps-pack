import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { initAuth } from '@/lib/auth';
import { AppDetailPage } from '@/pages/app-detail';
import { AppsPage } from '@/pages/apps';
import { DashboardPage } from '@/pages/dashboard';
import { LaunchPage } from '@/pages/launch';
import '@/index.css';

// Initialize auth (and the Keycloak redirect dance) before rendering.
await initAuth();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchInterval: 10_000, staleTime: 5_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="apps" element={<AppsPage />} />
            <Route path="apps/:namespace/:name" element={<AppDetailPage />} />
            <Route path="launch" element={<LaunchPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
