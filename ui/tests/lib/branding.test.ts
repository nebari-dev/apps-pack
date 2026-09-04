import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBranding, type BrandingConfig, safeCssValue } from '@/lib/branding';

const DEFAULT_TITLE = 'Nebari Apps';

afterEach(() => {
  // Reset the document mutations applied by applyBranding.
  document.title = DEFAULT_TITLE;
  for (const el of document.querySelectorAll('style[data-branding]')) {
    el.remove();
  }
  for (const el of document.querySelectorAll("link[rel~='icon']")) {
    el.remove();
  }
});

describe('safeCssValue', () => {
  it('accepts valid CSS token values', () => {
    expect(safeCssValue('#0066cc')).toBe('#0066cc');
    expect(safeCssValue('oklch(55% 0.19 250)')).toBe('oklch(55% 0.19 250)');
    expect(safeCssValue('0.625rem')).toBe('0.625rem');
    expect(safeCssValue('rgb(1 2 3)')).toBe('rgb(1 2 3)');
  });

  it('rejects empty / missing values', () => {
    expect(safeCssValue('')).toBeUndefined();
    expect(safeCssValue(undefined)).toBeUndefined();
  });

  it.each([
    ['rule terminator', '#fff; color: red'],
    ['opening brace', '#fff } body {'],
    ['closing brace', 'red}'],
    ['angle brackets', '<script>'],
    ['double quote', 'red"'],
    ['single quote', "red'"],
    ['backslash', 'red\\'],
    ['url()', 'url(http://evil)'],
    ['url() with space', 'url ( x )'],
    ['expression()', 'expression(alert(1))'],
    ['javascript:', 'javascript:alert(1)'],
  ])('rejects %s', (_label, value) => {
    expect(safeCssValue(value)).toBeUndefined();
  });
});

describe('applyBranding', () => {
  it('sets the document title when configured', () => {
    applyBranding({ title: 'Acme Apps' });
    expect(document.title).toBe('Acme Apps');
  });

  it('leaves the title untouched when not configured', () => {
    applyBranding({});
    expect(document.title).toBe(DEFAULT_TITLE);
  });

  it('sets a favicon link when configured', () => {
    applyBranding({ faviconUrl: '/brand-favicon.png' });
    const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
    expect(link?.getAttribute('href')).toBe('/brand-favicon.png');
    // The type hint from index.html would be wrong for a non-SVG favicon.
    expect(link?.hasAttribute('type')).toBe(false);
  });

  it('injects theme tokens as kebab-case CSS vars scoped to :root and .dark', () => {
    applyBranding({
      theme: {
        light: { primary: '#0066cc', primaryForeground: '#ffffff', headerBackground: '#f5f5f5' },
        dark: { primary: '#4da6ff' },
      },
    });
    const css = document.querySelector('style[data-branding]')?.textContent ?? '';
    expect(css).toContain(':root {');
    expect(css).toContain('--primary: #0066cc;');
    expect(css).toContain('--primary-foreground: #ffffff;');
    expect(css).toContain('--header: #f5f5f5;');
    expect(css).toContain('.dark {');
    expect(css).toContain('--primary: #4da6ff;');
  });

  it('injects the derived-shade tokens when pinned explicitly', () => {
    // primaryHover / sidebar* normally follow primary, primaryForeground and
    // ring (see index.css); they are still overridable for a shade that is not
    // a plain derivation.
    applyBranding({
      theme: {
        light: {
          primaryHover: '#004c99',
          sidebarPrimary: '#0066cc',
          sidebarPrimaryForeground: '#ffffff',
          sidebarRing: '#0066cc',
        },
      },
    });
    const css = document.querySelector('style[data-branding]')?.textContent ?? '';
    expect(css).toContain('--primary-hover: #004c99;');
    expect(css).toContain('--sidebar-primary: #0066cc;');
    expect(css).toContain('--sidebar-primary-foreground: #ffffff;');
    expect(css).toContain('--sidebar-ring: #0066cc;');
  });

  it('drops unsafe theme token values while keeping safe ones', () => {
    applyBranding({
      theme: { light: { primary: '#0066cc', background: 'red; } body { color: red' } },
    });
    const css = document.querySelector('style[data-branding]')?.textContent ?? '';
    expect(css).toContain('--primary: #0066cc;');
    expect(css).not.toContain('--background');
  });

  it('does not inject a style element when no theme is configured', () => {
    applyBranding({});
    expect(document.querySelector('style[data-branding]')).toBeNull();
  });

  it('does not inject a style element when the theme maps are empty', () => {
    applyBranding({ theme: { light: {}, dark: {} } });
    expect(document.querySelector('style[data-branding]')).toBeNull();
  });
});

describe('loadBranding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWith(config: unknown) {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => config })) as unknown as typeof fetch,
    );
    const mod = await import('@/lib/branding');
    return mod.loadBranding();
  }

  it('keeps http(s) and root-relative logo/favicon URLs', async () => {
    const config = await loadWith({
      logoUrl: 'https://cdn.example.com/logo.svg',
      logoUrlDark: '/nebari-logo_dark.svg',
      faviconUrl: 'http://example.com/favicon.ico',
    });
    expect(config.logoUrl).toBe('https://cdn.example.com/logo.svg');
    expect(config.logoUrlDark).toBe('/nebari-logo_dark.svg');
    expect(config.faviconUrl).toBe('http://example.com/favicon.ico');
  });

  it('drops javascript:, data:text/html, non-base64 data:image, and malformed URLs', async () => {
    const config = await loadWith({
      logoUrl: 'javascript:alert(1)',
      logoUrlDark: 'not a url',
      faviconUrl: 'data:image/svg+xml,<svg/>',
    });
    expect(config.logoUrl).toBeUndefined();
    expect(config.logoUrlDark).toBeUndefined();
    expect(config.faviconUrl).toBeUndefined();

    const other = await loadWith({
      logoUrl: 'data:text/html;base64,PGgxPmhpPC9oMT4=',
      logoUrlDark: 'data:application/octet-stream;base64,AAAA',
    });
    expect(other.logoUrl).toBeUndefined();
    expect(other.logoUrlDark).toBeUndefined();
  });

  it('keeps base64-encoded data: image URIs from the allow-list', async () => {
    const config = await loadWith({
      logoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      faviconUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
    });
    expect(config.logoUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(config.faviconUrl).toBe('data:image/svg+xml;base64,PHN2Zy8+');
  });

  it('turns the chart default (empty strings) into no branding at all', async () => {
    const config = await loadWith({
      title: '',
      logoUrl: '',
      logoUrlDark: '',
      faviconUrl: '',
      theme: { light: {}, dark: {} },
      banners: { top: {}, bottom: {} },
    });
    expect(config.logoUrl).toBeUndefined();
    expect(config.logoUrlDark).toBeUndefined();
    expect(config.faviconUrl).toBeUndefined();

    applyBranding(config as BrandingConfig);
    expect(document.title).toBe(DEFAULT_TITLE);
    expect(document.querySelector('style[data-branding]')).toBeNull();
    expect(document.querySelector("link[rel~='icon']")).toBeNull();
  });

  it('rejects when /config.json is missing', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    );
    const mod = await import('@/lib/branding');
    await expect(mod.loadBranding()).rejects.toThrow('404');
    // A failed load leaves the cached branding empty, so consumers fall back.
    expect(mod.getBranding()).toEqual({});
  });
});
