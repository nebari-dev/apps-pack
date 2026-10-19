import { test, expect, beforeAll, setDefaultTimeout } from 'bun:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

setDefaultTimeout(180_000);

const SITE = join(import.meta.dir, '..');
const DIST = join(SITE, 'dist');
const BASE = '/apps-pack'; // production base (URL prefix), no trailing slash

const TITLES: Record<string, string> = {
  '': 'Nebari Apps Pack',
  'getting-started': 'Getting started',
  'launching-apps': 'Launching apps',
  mcp: 'MCP server',
  skill: 'Scaffolding skill',
  branding: 'Branding',
  'local-development': 'Local development',
  troubleshooting: 'Troubleshooting',
  runbook: 'Runbook',
  upgrading: 'Upgrading',
  'ci-cd': 'CI/CD &amp; releasing',
  configuration: 'Configuration',
  'app-crd-reference': 'App CRD Reference',
  'api-reference': 'REST API',
  architecture: 'Architecture &amp; auth',
};

// Astro emits files at dist/ root (base only prefixes URLs, it does not nest output).
function pagePath(slug: string): string {
  return slug === '' ? join(DIST, 'index.html') : join(DIST, slug, 'index.html');
}
function readPage(slug: string): string {
  return readFileSync(pagePath(slug), 'utf8');
}

beforeAll(async () => {
  await $`bun run build`.cwd(SITE);
});

test('all 15 pages render at dist root with their titles', () => {
  for (const [slug, title] of Object.entries(TITLES)) {
    expect(existsSync(pagePath(slug))).toBe(true);
    expect(readPage(slug)).toContain(title);
  }
  // Nav links carry the production base prefix (Starlight prepends base to nav).
  expect(readPage('')).toContain(`href="${BASE}/`);
});

test('sidebar links all resolve to built pages', () => {
  const html = readPage('getting-started');
  expect(html).toContain('Getting Started');
  expect(html).toContain('Documentation');
  expect(html).toContain('Reference');
  for (const slug of Object.keys(TITLES)) {
    const href = slug === '' ? `${BASE}/` : `${BASE}/${slug}/`;
    expect(html).toContain(`href="${href}"`);
  }
});

test('markdown body links are base-prefixed and internal links resolve', () => {
  const html = readPage('');
  // Body links written as /getting-started/ must come out base-prefixed.
  expect(html).toContain(`href="${BASE}/getting-started/"`);
  expect(html).not.toContain('href="/getting-started/"');

  // Every internal href on every page must map to a built file.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith('.html') ? [p] : [];
    });
  for (const file of walk(DIST)) {
    const content = readFileSync(file, 'utf8');
    for (const m of content.matchAll(/href="(\/apps-pack\/[^"#?]*)"/g)) {
      const path = m[1].slice(BASE.length).replace(/\/$/, '');
      if (path.includes('.')) continue; // assets
      expect(existsSync(pagePath(path.replace(/^\//, '')))).toBe(true);
    }
  }
});

const REPO = join(SITE, '..');
const PIN = readFileSync(join(REPO, '.nebari-operator-version'), 'utf8').trim();

test('pin placeholders are filled from the repo pin files', () => {
  for (const slug of Object.keys(TITLES)) {
    expect(readPage(slug)).not.toMatch(/%[A-Z_]+%/);
  }
  expect(readPage('getting-started')).toContain(PIN);
});

test('every nebari-operator version written outside the docs matches .nebari-operator-version', () => {
  // README and agent docs are rendered by GitHub, so they carry the literal version.
  for (const file of ['README.md', 'AGENTS.md', 'docs/PLAN.md']) {
    const text = readFileSync(join(REPO, file), 'utf8');
    for (const [found] of text.matchAll(/v0\.\d+\.\d+-alpha\.\d+/g)) {
      expect(`${file}: ${found}`).toBe(`${file}: ${PIN}`);
    }
  }
  // Docs pages use the %NEBARI_OPERATOR_VERSION% placeholder instead.
  const docs = join(SITE, 'src', 'content', 'docs');
  for (const name of readdirSync(docs)) {
    expect(`${name}: ${readFileSync(join(docs, name), 'utf8').match(/v0\.\d+\.\d+-alpha\.\d+/)?.[0] ?? ''}`).toBe(
      `${name}: `,
    );
  }
});

test("every runbook link in the chart's alerts lands on a runbook heading", () => {
  const rules = readFileSync(join(REPO, 'charts', 'nebari-apps', 'templates', 'monitoring.yaml'), 'utf8');
  const anchors = [...rules.matchAll(/runbook_url: \{\{ \$runbook \}\}\/#([a-z0-9-]+)/g)].map((m) => m[1]);
  expect(anchors.length).toBeGreaterThan(0);
  const page = readPage('runbook');
  for (const anchor of new Set(anchors)) {
    expect(`#${anchor}: ${page.includes(`id="${anchor}"`)}`).toBe(`#${anchor}: true`);
  }
  // The default runbookUrl points at this page on the published site.
  const values = readFileSync(join(REPO, 'charts', 'nebari-apps', 'values.yaml'), 'utf8');
  expect(values).toContain(`runbookUrl: https://packs.nebari.dev${BASE}/runbook/`);
});
