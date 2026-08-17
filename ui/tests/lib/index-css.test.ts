import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Read the stylesheet from disk rather than importing it: the Tailwind plugin
// compiles CSS imports, and this test is about the authored source. Vitest runs
// with the ui/ package as its root, so resolve from there.
const css = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

/*
 * Branding from /config.json can only override the tokens listed in ThemeTokens
 * (lib/branding.ts). Any semantic token in index.css that is a plain shade of
 * one of those must therefore reference it with var() rather than repeat a
 * magenta primitive, or a rebranded deployment keeps flashing Nebari magenta on
 * hover. Re-pulling the theme (`shadcn add @nebari/theme`) reintroduces the
 * primitives, so this guards the derivation.
 */

function block(selector: string): string {
  const match = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) {
    throw new Error(`no ${selector} block found in index.css`);
  }
  return match[1];
}

// The first :root block holds the primitives; the semantic light tokens are the
// second one (the first block containing --primary).
const lightBlock = css
  .split(/:root\s*\{/)
  .map((chunk) => chunk.split('}')[0])
  .find((chunk) => /--primary:/.test(chunk));

describe.each([
  ['light', lightBlock ?? ''],
  ['dark', block('\\.dark')],
])('%s theme tokens', (mode, declarations) => {
  it('was located', () => {
    expect(declarations, `no semantic ${mode} block found in index.css`).not.toBe('');
  });

  it.each([
    ['--sidebar-primary', 'var(--primary)'],
    ['--sidebar-primary-foreground', 'var(--primary-foreground)'],
    ['--sidebar-ring', 'var(--ring)'],
  ])('derives %s from %s', (token, source) => {
    expect(declarations).toContain(`${token}: ${source};`);
  });

  it('derives --primary-hover from --primary', () => {
    const declaration = /--primary-hover:([^;]*);/.exec(declarations)?.[1];
    expect(declaration).toBeDefined();
    expect(declaration).toContain('var(--primary)');
    expect(declaration).not.toMatch(/--primary-magenta-/);
  });
});
