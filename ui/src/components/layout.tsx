import { Outlet } from 'react-router-dom';
import { Banner } from '@/components/banner';
import { Header } from '@/components/header';
import { useTheme } from '@/hooks/theme-provider';
import { getUser, logout } from '@/lib/auth';
import { getBranding } from '@/lib/branding';
import { TooltipProvider } from '@/ui/tooltip';

export function Layout() {
  const user = getUser();
  const { themeMode, isDarkMode, setThemeMode } = useTheme();
  const { banners } = getBranding();

  return (
    <TooltipProvider>
      {/* The banner offsets are no-ops (0px) unless a classification banner is
          configured - see components/banner.tsx. */}
      <div className="flex min-h-screen flex-col pt-(--top-banner-height,0px) pb-(--bottom-banner-height,0px)">
        <Banner position="top" config={banners?.top} />

        <Header
          user={user}
          isDarkMode={isDarkMode}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
          onSignOut={() => void logout()}
        />

        <main className="min-w-0 flex-1 bg-body-background px-10 py-8">
          <Outlet />
        </main>

        <Banner position="bottom" config={banners?.bottom} />
      </div>
    </TooltipProvider>
  );
}
