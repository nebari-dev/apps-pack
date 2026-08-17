import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner } from '@/components/banner';

describe('Banner', () => {
  it('renders nothing when no banner is configured', () => {
    const { container } = render(<Banner position="top" />);
    expect(container).toBeEmptyDOMElement();

    const { container: empty } = render(<Banner position="top" config={{}} />);
    expect(empty).toBeEmptyDOMElement();
  });

  it('renders the configured text pinned to the requested edge', () => {
    render(<Banner position="bottom" config={{ text: 'CUI' }} />);

    const banner = screen.getByRole('note');
    expect(banner).toHaveTextContent('CUI');
    expect(banner).toHaveClass('bottom-0');
    // No colors configured, so it inherits the theme's inverted colors.
    expect(banner).toHaveClass('bg-foreground', 'text-background');
  });

  it('applies configured colors and drops unsafe ones', () => {
    render(
      <Banner
        position="top"
        config={{ text: 'CUI', background: '#502b85', foreground: 'red; } body {' }}
      />,
    );

    const banner = screen.getByRole('note');
    expect(banner).toHaveStyle({ backgroundColor: '#502b85' });
    // The unsafe foreground is dropped, so the theme fallback class stays on.
    expect(banner).toHaveClass('text-background');
    expect(banner).not.toHaveClass('bg-foreground');
  });

  it('publishes its height so the layout can make room', () => {
    render(<Banner position="top" config={{ text: 'CUI' }} />);

    // jsdom reports offsetHeight as 0, so this asserts the variable is
    // published at all - the real value comes from layout in a browser.
    expect(document.documentElement.style.getPropertyValue('--top-banner-height')).toBe('0px');
  });
});
