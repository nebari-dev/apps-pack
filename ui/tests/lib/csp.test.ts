import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs with the ui/ package as its root.
const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("Content-Security-Policy", () => {
  const html = read("index.html");
  const nginx = read("nginx.conf");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it("allows the inline theme bootstrap by its hash", () => {
    // index.html has one classic inline script; anything else must be a file.
    expect(inline).toHaveLength(1);
    const hash = createHash("sha256").update(inline[0]).digest("base64");
    // When the bootstrap script changes, put this hash in ui/nginx.conf.
    expect(nginx).toContain(`'sha256-${hash}'`);
  });

  it("allows no inline or eval scripts", () => {
    const csp = nginx.match(/Content-Security-Policy "([^"]+)"/)?.[1] ?? "";
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
