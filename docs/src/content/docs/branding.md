---
title: Branding
---

The apps-ui ships with built-in Nebari branding — title, logos, favicon, theme colors — and
needs no configuration. Operators can rebrand it **without rebuilding the image**: branding
is delivered at runtime through a `/config.json` file the UI fetches at startup and applies
before React mounts (title, favicon, theme CSS variables), in the header (logo), and around
the page (classification banners).

This is the same contract the other Nebari packs use ([nebari-landing](https://github.com/nebari-dev/nebari-landing),
llm-serving-pack, provenance-collector-pack) — the same `/config.json` field names, the same
`branding.*` Helm values, and the same `BRANDING_*` env vars — so a fleet can be rebranded
uniformly. One thing differs here: Keycloak settings are **not** in `/config.json`, because
this UI reads those from the API (`GET /api/v1/config`, see [Architecture & auth](/architecture/)).

## Configurable fields

| Field | Helm value | Description |
|---|---|---|
| `title` | `ui.title` | Browser-tab title. |
| `logoUrl` | `ui.branding.logoUrl` | Header logo (light mode / default). Absolute `http(s)` URL, root-relative path, or base64 `data:` image URI. |
| `logoUrlDark` | `ui.branding.logoUrlDark` | Dark-mode header logo. Falls back to `logoUrl`, then the built-in dark logo. |
| `faviconUrl` | `ui.branding.faviconUrl` | Favicon URL. |
| `theme.light` / `theme.dark` | `ui.branding.theme.*` | CSS variable overrides per mode. See [Theme tokens](#theme-tokens). |
| `banners.top` / `banners.bottom` | `ui.branding.banners.*` | Classification banners. See [Classification banners](#classification-banners). |

Every field is optional. Any field left empty uses the built-in Nebari default, so an
unbranded install looks exactly as it does today.

### Theme tokens

Each of `theme.light` and `theme.dark` is a map of camelCase token names to CSS values,
applied as the kebab-case custom property (`primaryForeground` → `--primary-foreground`)
scoped to `:root` and `.dark` respectively.

The tokens shared with every Nebari pack:

`primary`, `primaryForeground`, `primaryHover`, `background`, `foreground`, `secondary`,
`secondaryForeground`, `muted`, `mutedForeground`, `accent`, `accentForeground`, `border`,
`ring`, `radius`, `sidebarPrimary`, `sidebarPrimaryForeground`, `sidebarRing`

Plus this pack's top-bar tokens, since its chrome is a full-width header:

`headerBackground`, `headerForeground`, `headerBorder`, `bodyBackground`

`primaryHover` — the hover and pressed fill on buttons, badges, switches, sliders,
checkboxes and radios — along with `sidebarPrimary`, `sidebarPrimaryForeground` and
`sidebarRing`, is **derived** from `primary`, `primaryForeground` and `ring`, so overriding
those three rebrands them too. Set a derived token explicitly only to pin a shade that is
not a plain derivation of `primary`.

The `header*` and `bodyBackground` tokens are deliberately *not* derived: the top bar is
neutral chrome by design, so it stays neutral unless you rebrand it on purpose.

**On unlisted tokens:** the list above is the supported contract, not a runtime filter. Any
other camelCase key under `theme.light` / `theme.dark` is still applied as the matching
`--kebab-case` custom property, but it is unsupported and may stop working when the theme is
re-pulled from the Nebari design registry.

### Classification banners

`banners.top` and `banners.bottom` render a full-width strip above the header and below the
page content — for markings such as U.S. government CUI labels. A banner is disabled while
its `text` is empty, which is the default.

| Field | Description |
|---|---|
| `text` | Banner text, rendered as plain text (never HTML). Empty disables the banner. |
| `background` | CSS background color. Defaults to the theme's foreground color, which follows light/dark mode. |
| `foreground` | CSS text color. Defaults to the theme's background color. |

## Kubernetes / Helm

Set `ui.title` and `ui.branding` in values. The chart renders them into a `/config.json`
ConfigMap mounted into the UI pod:

```yaml
ui:
  title: "Acme Apps"
  branding:
    logoUrl: "https://cdn.acme.example/logo.svg"
    logoUrlDark: "https://cdn.acme.example/logo-dark.svg"
    faviconUrl: "https://cdn.acme.example/favicon.svg"
    theme:
      light:
        primary: "oklch(55% 0.19 250)"
        primaryForeground: "#ffffff"
        headerBackground: "#ffffff"
      dark:
        primary: "oklch(62% 0.21 250)"
    banners:
      top:
        text: "CUI"
        background: "#502b85"
        foreground: "#ffffff"
      bottom:
        text: "CUI"
```

A branding-only `helm upgrade` rolls the UI pod automatically — its Deployment is annotated
with a checksum of the rendered ConfigMap.

### The landing-page tile

The UI's tile on the Nebari landing page is configurable separately, since it is rendered by
the nebari-operator rather than by the UI:

```yaml
ui:
  landingPage:
    displayName: "Acme Apps"
    description: "Launch and manage web applications on this cluster."
    category: "Platform"
    # Leave empty for the pack's built-in icon.
    icon: "https://cdn.acme.example/icon.svg"
```

## Outside Kubernetes

Running the standalone `apps-ui` image without a chart, branding resolves from, in order:

1. A **local `config.json`** — the placeholder baked into the image, a file mounted over
   `/usr/share/nginx/html/config.json`, or one pointed to by `BRANDING_CONFIG_FILE`.
2. **Environment variables**, overlaid onto that file at container start by the image
   entrypoint (a no-op under the read-only Kubernetes mount):

   | Env var | Field |
   |---|---|
   | `BRANDING_TITLE` | `title` |
   | `BRANDING_LOGO_URL` | `logoUrl` |
   | `BRANDING_LOGO_URL_DARK` | `logoUrlDark` |
   | `BRANDING_FAVICON_URL` | `faviconUrl` |
   | `BRANDING_THEME` | `theme` (raw JSON, e.g. `'{"light":{"primary":"#0066cc"},"dark":{}}'`) |
   | `BRANDING_BANNERS` | `banners` (raw JSON, e.g. `'{"top":{"text":"CUI"},"bottom":{}}'`) |

   ```bash
   docker run -p 8080:8080 \
     -e API_URL=http://apps-api:8080 \
     -e BRANDING_TITLE="Acme Apps" \
     -e BRANDING_LOGO_URL=https://cdn.acme.example/logo.svg \
     ghcr.io/nebari-dev/apps-pack/apps-ui
   ```

3. **Built-in Nebari defaults** for any field still unset.

Precedence overall is therefore: chart-rendered `config.json` (in Kubernetes) → local
`config.json` file → `BRANDING_*` env vars → built-in defaults. A malformed
`BRANDING_THEME` / `BRANDING_BANNERS` value is logged and skipped rather than failing
container startup, and an unreachable or invalid `/config.json` leaves the built-in defaults
in place rather than blocking the UI from booting.

## Security

Theme token and banner color values are validated in the browser before they are applied:
any value containing CSS-injection characters (`;`, `{`, `}`, `<`, `>`, quotes, backslash,
`url(`, `expression(`, `javascript:`) is dropped rather than injected into the stylesheet.
Logo and favicon URLs are restricted to `http(s)` URLs, root-relative paths, and
base64-encoded `data:` URIs of allow-listed image types. Banner text is always rendered as
plain text, never HTML.
