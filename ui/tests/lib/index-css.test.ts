import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Read the stylesheet from disk rather than importing it: the Tailwind plugin
// compiles CSS imports, and this test is about the authored source. Vitest runs
// with the ui/ package as its root, so resolve from there.
const css = readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");

/*
 * Branding from /config.json can only override the tokens listed in ThemeTokens
 * (lib/branding.ts). Any semantic token in index.css that is a plain shade of
 * one of those must therefore reference it with var() rather than repeat a
 * magenta primitive, or a rebranded deployment keeps flashing Nebari magenta on
 * hover. Re-pulling the theme (`shadcn add @nebari/theme`) reintroduces the
 * primitives, so this guards the derivation.
 */

/** Bodies of every `<selector> { ... }` block, in file order. */
function blocks(selector: string): string[] {
  return [...css.matchAll(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`, "g"))].map(
    (m) => m[1],
  );
}

// App changes live in the "App overrides" blocks at the end of the file, after
// the registry's, so re-applying the theme leaves them alone: the last :root
// and the last .dark.
const overrides = css.slice(css.indexOf("App overrides:"));
const lightOverride = blocks(":root").at(-1) ?? "";
const darkOverride = blocks("\\.dark").at(-1) ?? "";

it("keeps the app overrides after the registry blocks", () => {
  expect(css.indexOf("App overrides:")).toBeGreaterThan(css.lastIndexOf("--primary:"));
  expect(overrides).toMatch(/:root\s*\{/);
  expect(overrides).toMatch(/\.dark\s*\{/);
  expect(overrides).toContain("--color-header-border: var(--header-border);");
});

describe.each([
  ["light", lightOverride],
  ["dark", darkOverride],
])("%s theme tokens", (mode, declarations) => {
  it("was located", () => {
    expect(declarations, `no semantic ${mode} block found in index.css`).not.toBe("");
  });

  it.each([
    ["--sidebar-primary", "var(--primary)"],
    ["--sidebar-primary-foreground", "var(--primary-foreground)"],
    ["--sidebar-ring", "var(--ring)"],
  ])("derives %s from %s", (token, source) => {
    expect(declarations).toContain(`${token}: ${source};`);
  });

  it("derives --primary-hover from --primary", () => {
    const declaration = /--primary-hover:([^;]*);/.exec(declarations)?.[1];
    expect(declaration).toBeDefined();
    expect(declaration).toContain("var(--primary)");
    expect(declaration).not.toMatch(/--primary-magenta-/);
  });
});
