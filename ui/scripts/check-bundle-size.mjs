#!/usr/bin/env node
// Bundle budget: gzip size of what the browser loads before first paint (the
// entry script plus everything index.html preloads) and of all JS. Budgets
// live in package.json "bundleBudget" (kB, gzip); raise them deliberately.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url).pathname;
const { bundleBudget } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length / 1024;

const html = readFileSync(join(dist, "index.html"), "utf8");
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const allJs = readdirSync(join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => `assets/${f}`);

const rows = [
  ["initial", initial, bundleBudget.initial],
  ["total-js", allJs, bundleBudget.totalJs],
];
let failed = false;
for (const [name, files, budget] of rows) {
  const size = files.reduce((sum, f) => sum + gz(f), 0);
  const ok = size <= budget;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${size.toFixed(1)} kB gzip (budget ${budget} kB, ${files.length} files)`);
}
if (failed) {
  console.error("Bundle over budget. Split the new code out of the initial load, or raise bundleBudget in package.json.");
  process.exit(1);
}
