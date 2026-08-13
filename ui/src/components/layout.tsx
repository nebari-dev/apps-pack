import { Outlet } from 'react-router-dom';
import { Header } from '@/components/header';
import { useTheme } from '@/hooks/theme-provider';
import { getUser, logout } from '@/lib/auth';
import { TooltipProvider } from '@/ui/tooltip';

export function Layout() {
  const user = getUser();
  const { themeMode, setThemeMode } = useTheme();

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        <Header
          user={user}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
          onSignOut={() => void logout()}
        />

        <main className="min-w-0 flex-1 bg-body-background px-10 py-8">
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}
