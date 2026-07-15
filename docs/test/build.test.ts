import { test, expect, beforeAll, setDefaultTimeout } from 'bun:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

setDefaultTimeout(180_000);

const SITE = join(import.meta.dir, '..');
const DIST = join(SITE, 'dist');
const BASE = '/nebari-apps-pack'; // production base (URL prefix), no trailing slash

const TITLES: Record<string, string> = {
  '': 'Nebari Apps Pack',
  'getting-started': 'Getting started',
  'launching-apps': 'Launching apps',
  mcp: 'MCP server',
  skill: 'Scaffolding skill',
  'local-development': 'Local development',
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

test('all 9 pages render at dist root with their titles', () => {
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
    for (const m of content.matchAll(/href="(\/nebari-apps-pack\/[^"#?]*)"/g)) {
      const path = m[1].slice(BASE.length).replace(/\/$/, '');
      if (path.includes('.')) continue; // assets
      expect(existsSync(pagePath(path.replace(/^\//, '')))).toBe(true);
    }
  }
});
