import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Nebari design-system rules for app code (src/components/ui/* is registry
 * code and is fixed upstream): semantic tokens only, motion gated behind
 * prefers-reduced-motion, and Tailwind v4 variable syntax.
 */

const SRC = path.resolve(process.cwd(), "src");
const REGISTRY = path.join(SRC, "components", "ui");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (full === REGISTRY) return [];
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const PALETTE =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";

const RULES: [string, RegExp][] = [
  [
    "no raw palette colours (use a semantic token)",
    new RegExp(`\\b[a-z-]+-(?:${PALETTE})-\\d{2,3}\\b`),
  ],
  ["no dark: variants (semantic tokens already switch with the theme)", /(?<![\w-])dark:/],
  ["no hex or rgb() colour literals", /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|rgba?\(/],
  ["no animate-* without motion-safe:", /(?<![\w:-])animate-(?!none)/],
  ["no transition without motion-safe:", /(?<![\w:-])transition(?:-[a-z]+)?(?![\w-])/],
  ["no -[--var] (Tailwind v4 needs -(--var))", /-\[--/],
];

// Only class strings and JSX attributes matter; comments are skipped.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("app code follows the design-system rules", () => {
  const sources = files(SRC).map(
    (f) => [path.relative(SRC, f), code(readFileSync(f, "utf8"))] as const,
  );

  it("scans the app's components and pages", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(RULES)("%s", (_rule, pattern) => {
    const hits = sources.flatMap(([file, text]) =>
      text
        .split("\n")
        .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
