/*
 * Runtime branding, loaded from /config.json at startup.
 *
 * This mirrors the branding contract shared with the other Nebari packs
 * (nebari-landing, llm-serving-pack, provenance-collector-pack): the same
 * `/config.json` field names, the same `ui.branding.*` Helm values, and the
 * same `BRANDING_*` env vars. Only the Keycloak block differs - this pack gets
 * auth config from the API (`GET /api/v1/config`, see lib/auth.ts), so
 * /config.json carries branding only.
 *
 * Where the file comes from, per field, highest precedence first:
 *   1. The chart-rendered ConfigMap mounted over /usr/share/nginx/html/config.json
 *      (Kubernetes; values.yaml -> ui.title / ui.branding.*)
 *   2. A local config.json, or one named by BRANDING_CONFIG_FILE
 *   3. BRANDING_* env vars, overlaid at container start (ui/docker-entrypoint.sh)
 *   4. The built-in Nebari defaults - index.html title/favicon, the bundled
 *      logos, and the theme tokens in index.css
 *
 * Call loadBranding() once before rendering and applyBranding() to apply the
 * document-level parts ahead of the first paint (see main.tsx); afterwards read
 * the cached value with getBranding().
 */

/**
 * Theme token overrides keyed by the camelCase token name (e.g.
 * `primaryForeground`). Applied at runtime as the kebab-case CSS custom
 * property `--primary-foreground`, scoped to `:root` (light) or `.dark`.
 *
 * The first thirteen are the tokens every Nebari pack accepts. The `header*`
 * and `bodyBackground` tokens are extras specific to this pack, whose chrome is
 * a full-width top bar - see index.css.
 */
export type ThemeTokens = Partial<
  Record<
    | 'primary'
    | 'primaryForeground'
    | 'background'
    | 'foreground'
    | 'secondary'
    | 'secondaryForeground'
    | 'muted'
    | 'mutedForeground'
    | 'accent'
    | 'accentForeground'
    | 'border'
    | 'ring'
    | 'radius'
    | 'headerBackground'
    | 'headerForeground'
    | 'headerBorder'
    | 'bodyBackground',
    string
  >
>;

export type BannerConfig = {
  /** Banner text, rendered as plain text (never HTML). */
  text?: string;
  /** Optional CSS background color. Falls back to the theme foreground color. */
  background?: string;
  /** Optional CSS text color. Falls back to the theme background color. */
  foreground?: string;
};

export type BrandingConfig = {
  /** Optional page-title override shown in the browser tab. */
  title?: string;
  /** URL to a custom logo used in the header (light mode / default). */
  logoUrl?: string;
  /** URL to a custom dark-mode logo; falls back to logoUrl, then the built-in. */
  logoUrlDark?: string;
  /** URL to a custom favicon. */
  faviconUrl?: string;
  /** CSS variable overrides applied at runtime for light and dark modes. */
  theme?: { light?: ThemeTokens; dark?: ThemeTokens };
  /** Optional classification banners pinned above the header / below content. */
  banners?: { top?: BannerConfig; bottom?: BannerConfig };
};

// Block CSS injection vectors: rule terminators, braces, HTML chars, quotes,
// backslashes, and url()/expression()/javascript: functions. A token value
// containing any of these is dropped rather than applied.
const UNSAFE_CSS = /[;<>{}"'\\]|url\s*\(|expression\s*\(|javascript:/i;

/** Returns the value unchanged if it is a safe CSS token, otherwise undefined. */
export function safeCssValue(value: string | undefined): string | undefined {
  return value && !UNSAFE_CSS.test(value) ? value : undefined;
}

// Image MIME types accepted as inline data: URIs (only when base64-encoded).
const ALLOWED_DATA_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

// Accept only non-empty, well-formed http(s) URLs, root-relative paths, or
// base64-encoded data: image URIs from the allow-list above; anything else
// (including "") becomes undefined so a bad config value can't land in an
// <img src> or <link href>.
function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith('/')) {
    return value;
  }
  try {
    const { protocol } = new URL(value);
    if (protocol === 'http:' || protocol === 'https:') {
      return value;
    }
    if (protocol === 'data:') {
      // Only accept base64-encoded images whose MIME type is on the allow-list;
      // reject data:text/html, non-base64 payloads, and anything else.
      const match = value.match(/^data:([^;,]+)(;base64)?,/);
      if (!match) {
        return undefined;
      }
      const mime = match[1].toLowerCase();
      const isBase64 = Boolean(match[2]);
      return isBase64 && ALLOWED_DATA_MIME_TYPES.has(mime) ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

let branding: BrandingConfig = {};

/** Fetch and cache /config.json. The network request happens at most once. */
export async function loadBranding(): Promise<BrandingConfig> {
  const resp = await fetch('/config.json');
  if (!resp.ok) {
    throw new Error(`Failed to load /config.json: ${resp.status}`);
  }
  const config = (await resp.json()) as BrandingConfig;
  // Drop malformed logo/favicon URLs (defence-in-depth, mirroring the
  // theme-token sanitisation applied in applyBranding).
  config.logoUrl = sanitizeUrl(config.logoUrl);
  config.logoUrlDark = sanitizeUrl(config.logoUrlDark);
  config.faviconUrl = sanitizeUrl(config.faviconUrl);
  branding = config;
  return branding;
}

/**
 * Returns the cached branding. Empty until loadBranding() resolves, and empty
 * forever when no branding is configured - every consumer falls back to the
 * built-in Nebari defaults per field.
 */
export function getBranding(): BrandingConfig {
  return branding;
}

const toKebab = (s: string) => s.replace(/([A-Z])/g, '-$1').toLowerCase();

/** Renders a token map to CSS declarations, dropping empty/unsafe values. */
function toCssVars(tokens: ThemeTokens): string {
  return Object.entries(tokens)
    .map(([key, value]) => [key, safeCssValue(value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `  --${toKebab(key)}: ${value};`)
    .join('\n');
}

/**
 * Applies the document-level branding - page title, favicon, and theme token
 * overrides - before React mounts. Logos and banners are applied by the
 * components that render them (header.tsx, banner.tsx).
 *
 * Every field falls back to the built-in Nebari default when unset, so an
 * all-empty branding block (the default) leaves the app visually identical.
 *
 * Theme overrides are injected as a <style> appended last to <head> so they win
 * the cascade over the base tokens defined in index.css.
 */
export function applyBranding(config: BrandingConfig): void {
  if (config.title) {
    document.title = config.title;
  }

  if (config.faviconUrl) {
    const link = (document.querySelector("link[rel~='icon']") ??
      Object.assign(document.createElement('link'), { rel: 'icon' })) as HTMLLinkElement;
    link.href = config.faviconUrl;
    // A branded favicon may not be an SVG; let the browser sniff the type.
    link.removeAttribute('type');
    document.head.appendChild(link);
  }

  if (config.theme) {
    let css = '';
    const light = config.theme.light ? toCssVars(config.theme.light) : '';
    if (light) {
      css += `:root {\n${light}\n}\n`;
    }
    const dark = config.theme.dark ? toCssVars(config.theme.dark) : '';
    if (dark) {
      css += `.dark {\n${dark}\n}\n`;
    }
    if (css) {
      const style = document.createElement('style');
      style.setAttribute('data-branding', '');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }
}
