import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  BarChart3,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Rocket,
  Sun,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import nebariLogo from '@/assets/nebari-logo.svg';
import nebariLogoDark from '@/assets/nebari-logo_dark.svg';
import { isThemeMode, type ThemeMode } from '@/hooks/use-theme-preference';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import {
  MenuBarActions,
  MenuBarBrand,
  MenuBarNav,
  NavigationMenu,
  NavLink,
} from '@/ui/navigation-menu';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/apps', label: 'Apps', icon: Rocket, end: false },
  { to: '/metrics', label: 'Metrics', icon: BarChart3, end: false },
];

type User = {
  name?: string;
  email?: string;
};

export type HeaderProps = {
  user?: User | null;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  onSignOut?: () => void;
};

/**
 * Application header built on the Nebari Design registry navigation menu
 * (nebari-dev/nebari-design#131), mirroring nebari-landing's Header. The app
 * has no notifications feature, so the notifications bell is omitted.
 */
export function Header({ user, themeMode = 'system', onThemeChange, onSignOut }: HeaderProps) {
  const { pathname } = useLocation();

  return (
    <NavigationMenu className="h-14 justify-between border-header-border bg-header-background pl-4 text-header-foreground">
      <MenuBarBrand href="/" aria-label="Go to homepage">
        <img src={nebariLogo} alt="Nebari" className="h-8 w-auto dark:hidden" />
        <img src={nebariLogoDark} alt="Nebari" className="hidden h-8 w-auto dark:block" />
      </MenuBarBrand>

      <MenuBarNav className="ml-4">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            active={end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)}
            icon={<Icon />}
            render={<Link to={to} />}
          >
            {label}
          </NavLink>
        ))}
      </MenuBarNav>

      <MenuBarActions className="gap-2">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            variant="ghost"
            aria-label="Account menu"
            className="h-auto px-2.5 py-1 hover:bg-header-action-hover hover:no-underline focus-visible:ring-offset-0 active:bg-header-action-hover data-[popup-open]:bg-header-action-hover data-[popup-open]:no-underline"
          >
            <Avatar>
              <AvatarFallback className="bg-primary font-semibold text-primary-foreground">
                {getUserInitials(user?.name, user?.email)}
              </AvatarFallback>
            </Avatar>

            <span>{user?.name || user?.email || 'Account'}</span>

            <ChevronDown />
          </DropdownMenuTrigger>

          <DropdownMenuPortal>
            <DropdownMenuContent align="end" className="w-[248px] p-2">
              <div className="border-b px-1.5 pb-2">
                <p className="font-medium text-foreground text-sm">
                  {user?.name || 'Authentication disabled'}
                </p>
                {user?.email ? (
                  <p className="text-muted-foreground text-xs">{user.email}</p>
                ) : null}
              </div>

              <div className="py-2">
                <MenuPrimitive.RadioGroup
                  aria-label="Theme"
                  value={themeMode}
                  onValueChange={(value) => {
                    if (typeof value === 'string' && isThemeMode(value)) onThemeChange?.(value);
                  }}
                  className="flex h-[34px] items-center gap-1 rounded-md bg-muted p-1"
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
                </MenuPrimitive.RadioGroup>
              </div>

              {user ? (
                <>
                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    className="leading-5 text-sign-out-foreground data-[highlighted]:text-sign-out-foreground"
                    onClick={() => onSignOut?.()}
                  >
                    <LogOut className="size-4 shrink-0" aria-hidden="true" />
                    Sign out
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      </MenuBarActions>
    </NavigationMenu>
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
    <MenuPrimitive.RadioItem
      value={value}
      aria-label={label}
      title={label}
      // Keep the menu open after switching themes so the change is visible.
      closeOnClick={false}
      className={cn(
        'flex h-auto flex-1 cursor-pointer items-center justify-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'text-muted-foreground-strong hover:text-foreground',
        'data-checked:border-border-strong data-checked:bg-card data-checked:text-foreground data-checked:shadow-[0_1px_3px_0_rgba(0,0,0,0.10)]',
      )}
    >
      {children}
      <span>{text}</span>
    </MenuPrimitive.RadioItem>
  );
}

function getUserInitials(name?: string, email?: string) {
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
