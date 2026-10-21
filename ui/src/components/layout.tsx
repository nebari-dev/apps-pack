import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Banner } from "@/components/banner";
import { ErrorBoundary } from "@/components/error-boundary";
import { Header } from "@/components/header";
import { PageSkeleton } from "@/components/loading-skeletons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/theme-provider";
import { getUser, logout } from "@/lib/auth";
import { getBranding } from "@/lib/branding";

export function Layout() {
  const user = getUser();
  const { themeMode, isDarkMode, setThemeMode } = useTheme();
  const { banners } = getBranding();
  const { pathname } = useLocation();

  return (
    <TooltipProvider>
      {/* The banner offsets are no-ops (0px) unless a classification banner is
          configured - see components/banner.tsx. */}
      <div className="flex min-h-screen flex-col pt-(--top-banner-height,0px) pb-(--bottom-banner-height,0px)">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring"
        >
          Skip to content
        </a>
        <Banner position="top" config={banners?.top} />

        <Header
          user={user}
          isDarkMode={isDarkMode}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
          onSignOut={() => void logout()}
        />

        <main
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 bg-canvas px-4 py-6 outline-none sm:px-6 lg:px-10 lg:py-8"
        >
          {/* Keyed by route: a page that threw is retried when the user navigates. */}
          <ErrorBoundary key={pathname}>
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>

        <Banner position="bottom" config={banners?.bottom} />
      </div>
    </TooltipProvider>
  );
}
