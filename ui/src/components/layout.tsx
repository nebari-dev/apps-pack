import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Banner } from "@/components/banner";
import { ErrorBoundary } from "@/components/error-boundary";
import { Header } from "@/components/header";
import { LoadingStatus } from "@/components/loading-skeletons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/theme-provider";
import { useChanged } from "@/hooks/use-changed";
import { getUser, logout } from "@/lib/auth";
import { getBranding } from "@/lib/branding";
import { ENTER } from "@/lib/motion";

export function Layout() {
  const user = getUser();
  const { themeMode, isDarkMode, setThemeMode } = useTheme();
  const { banners } = getBranding();
  const { pathname } = useLocation();
  // Pages ease in on navigation, never on the first paint after a load.
  const navigated = useChanged(pathname);

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
          {/* Route changes run in a transition (React Router's default), and this
              boundary stays mounted across them, so the previous page stays up
              while the next page's code loads instead of flashing a
              placeholder. Only the very first page of a load can suspend here,
              briefly, with nothing to show yet. Pages put skeletons where
              their data is loading. */}
          <Suspense fallback={<LoadingStatus label="Loading page" />}>
            {/* Keyed by route: a page that threw is retried when the user
                navigates, and the new page mounts fresh, easing in. */}
            <ErrorBoundary key={pathname}>
              <div className={navigated ? ENTER : undefined}>
                <Outlet />
              </div>
            </ErrorBoundary>
          </Suspense>
        </main>

        <Banner position="bottom" config={banners?.bottom} />
      </div>
    </TooltipProvider>
  );
}
