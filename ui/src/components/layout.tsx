import { LayoutDashboard, LogOut, Plus, Rocket } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import nebariLogo from '@/assets/Nebari-Logo-Horizontal-Lockup.svg';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { getUser, logout } from '@/lib/auth';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/apps', label: 'Apps', icon: Rocket, end: false },
  { to: '/launch', label: 'Launch app', icon: Plus, end: false },
];

export function Layout() {
  const user = getUser();

  return (
    <TooltipProvider>
      <div className="flex min-h-screen">
        <aside className="flex w-56 shrink-0 flex-col border-border border-r bg-card">
          <div className="flex h-14 items-center border-border border-b px-4">
            <img src={nebariLogo} alt="Nebari" className="h-6 dark:invert" />
            <span className="ml-2 font-medium text-muted-foreground text-sm">Apps</span>
          </div>
          <nav className="flex flex-1 flex-col gap-1 p-3">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="border-border border-t p-3">
            {user ? (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{user.name}</p>
                  <p className="truncate text-muted-foreground text-xs">{user.email}</p>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" onClick={() => void logout()}>
                        <LogOut />
                      </Button>
                    }
                  />
                  <TooltipContent>Sign out</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">Authentication disabled</p>
            )}
          </div>
        </aside>
        <main className="min-w-0 flex-1 bg-background p-6">
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}
