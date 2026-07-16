import { ChevronDown, LayoutDashboard, Monitor, Moon, Rocket, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import nebariLogo from '@/assets/nebari-logo.svg';
import nebariLogoDark from '@/assets/nebari-logo_dark.svg';
import { isThemeMode, type ThemeMode, useThemePreference } from '@/hooks/use-theme-preference';
import { getUser, logout } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { TooltipProvider } from '@/ui/tooltip';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/apps', label: 'Apps', icon: Rocket, end: false },
];

export function Layout() {
  const user = getUser();
  const { themeMode, setThemeMode } = useThemePreference();

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        <header className="flex h-[60px] w-full items-center justify-between border-border/60 border-b bg-header-background px-10">
          <div className="flex items-center gap-8">
            <NavLink to="/" className="flex items-center" aria-label="Go to homepage">
              <img src={nebariLogo} alt="Nebari" className="h-8 w-auto dark:hidden" />
              <img src={nebariLogoDark} alt="Nebari" className="hidden h-8 w-auto dark:block" />
            </NavLink>
            <nav className="flex items-center gap-1">
              {NAV.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'flex h-9 items-center gap-2 rounded-md px-3 font-medium text-sm transition-colors',
                      isActive
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )
                  }
                >
                  <Icon className="size-4" />
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Account menu"
                  className="flex items-center gap-3 rounded-md px-1 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              }
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary font-semibold text-primary-foreground text-sm">
                  {userInitials(user?.name, user?.email)}
                </AvatarFallback>
              </Avatar>
              <span className="font-medium text-foreground text-sm">
                {user?.name || user?.email || 'Account'}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-72">
              <div className="border-b px-3 py-2">
                <p className="font-medium text-foreground text-sm">
                  {user?.name || 'Authentication disabled'}
                </p>
                {user?.email ? (
                  <p className="text-muted-foreground text-xs">{user.email}</p>
                ) : null}
              </div>

              <div className="px-2 py-2">
                <DropdownMenuRadioGroup
                  aria-label="Theme"
                  value={themeMode}
                  onValueChange={(value) => {
                    if (typeof value === 'string' && isThemeMode(value)) setThemeMode(value);
                  }}
                  className="flex items-center gap-1 rounded-lg bg-muted p-1"
                >
                  <ThemeOption value="light" label="Light mode" text="Light">
                    <Sun className="h-4 w-4" />
                  </ThemeOption>
                  <ThemeOption value="dark" label="Dark mode" text="Dark">
                    <Moon className="h-4 w-4" />
                  </ThemeOption>
                  <ThemeOption value="system" label="System theme" text="System">
                    <Monitor className="h-4 w-4" />
                  </ThemeOption>
                </DropdownMenuRadioGroup>
              </div>

              {user ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="cursor-pointer" onClick={() => void logout()}>
                    Sign out
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-w-0 flex-1 bg-body-background px-10 py-8">
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}

function ThemeOption({
  value,
  label,
  text,
  children,
}: {
  value: ThemeMode;
  label: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuRadioItem
      value={value}
      aria-label={label}
      title={label}
      // Keep the menu open after switching themes so the change is visible.
      closeOnClick={false}
      className={cn(
        'flex-1 cursor-pointer justify-center gap-1.5 rounded-md text-muted-foreground transition-colors',
        'data-[highlighted]:bg-transparent data-[highlighted]:text-foreground',
        'data-checked:bg-background data-checked:text-foreground data-checked:shadow-sm data-checked:data-[highlighted]:bg-background',
      )}
    >
      {children}
      <span>{text}</span>
    </DropdownMenuRadioItem>
  );
}

function userInitials(name?: string, email?: string) {
  if (name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
  }
  if (email) {
    return email.slice(0, 2).toUpperCase();
  }
  return 'U';
}
