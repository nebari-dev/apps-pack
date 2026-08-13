import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Header } from '@/components/header';

function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('Header', () => {
  it('links the logo to the homepage', () => {
    renderWithRouter(<Header />);

    expect(screen.getByRole('link', { name: /go to homepage/i })).toHaveAttribute('href', '/');
  });

  it('shows the app navigation links', () => {
    renderWithRouter(<Header />);

    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /apps/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /metrics/i })).toBeInTheDocument();
  });

  it('shows the user name when signed in', () => {
    renderWithRouter(<Header user={{ name: 'John Doe', email: 'john@example.com' }} />);

    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it('falls back to "Authentication disabled" in the menu when no user is present', async () => {
    const user = userEvent.setup();

    renderWithRouter(<Header user={null} />);

    await user.click(screen.getByRole('button', { name: /account menu/i }));

    expect(await screen.findByText('Authentication disabled')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('selects a theme mode from the profile menu', async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();

    renderWithRouter(
      <Header user={{ name: 'John Doe' }} themeMode="system" onThemeChange={onThemeChange} />,
    );

    await user.click(screen.getByRole('button', { name: /account menu/i }));
    await user.click(await screen.findByRole('menuitemradio', { name: /dark mode/i }));
    expect(onThemeChange).toHaveBeenCalledWith('dark');

    await user.click(screen.getByRole('menuitemradio', { name: /light mode/i }));
    expect(onThemeChange).toHaveBeenCalledWith('light');

    await user.click(screen.getByRole('menuitemradio', { name: /system theme/i }));
    expect(onThemeChange).toHaveBeenCalledWith('system');
  });

  it('reflects the current theme mode via aria-checked', async () => {
    const user = userEvent.setup();

    renderWithRouter(<Header user={{ name: 'John Doe' }} themeMode="dark" />);

    await user.click(screen.getByRole('button', { name: /account menu/i }));

    expect(await screen.findByRole('menuitemradio', { name: /dark mode/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: /light mode/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('menuitemradio', { name: /system theme/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls onSignOut from the account menu', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();

    renderWithRouter(<Header user={{ name: 'John Doe' }} onSignOut={onSignOut} />);

    await user.click(screen.getByRole('button', { name: /account menu/i }));
    await user.click(await screen.findByRole('menuitem', { name: /sign out/i }));

    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
