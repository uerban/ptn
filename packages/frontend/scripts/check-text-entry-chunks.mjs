#!/usr/bin/env node
// Text mode must start without MapLibre. Walk the static imports of the
// entry chunk and the Text home chunk in dist/assets and fail when any of
// them reaches the `vendor-map` chunk or the MapLibre worker. Dynamic
// `import()` edges are not followed: those load only when a map opens.
//
// Paired with the "Text mode start (excludes vendor-map; ...)" entry in
// .size-limit.json, which budgets the same chunks; size-limit measures bytes,
// this checks the graph.
//
//   node scripts/check-text-entry-chunks.mjs [dist/assets]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /^(vendor-map|maplibre-gl-worker)-/;
// The home route's dispatcher and Text home. The page entry itself is read
// from dist/index.html, since lazy modules can also be named `index-*`.
const ROOTS = [/^HomeDispatcher-[\w-]+\.js$/, /^TextHome-[\w-]+\.js$/];

/** Entry and preloaded chunks named by the built index.html. */
export function htmlEntryChunks(html) {
  return [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
}

// Minified static imports: `import"./x.js"`, `import{a as b}from"./x.js"`,
// `import*as c from"./x.js"` and `export{...}from"./x.js"`. Excludes
// `import("./x.js")`, which is a dynamic edge.
const STATIC_IMPORT =
  /(?:\bimport\s*(?:[\w$*{},\s]+?\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*)["']\.\/([^"']+\.js)["']/g;

export function staticImports(source) {
  const found = [];
  for (const match of source.matchAll(STATIC_IMPORT)) found.push(match[1]);
  return found;
}

/** Returns `{ roots, reached, offending }` for an assets directory. */
export function checkTextEntryChunks(assetsDir) {
  const files = new Set(readdirSync(assetsDir).filter((f) => f.endsWith(".js")));
  const html = join(assetsDir, "..", "index.html");
  const entries = existsSync(html) ? htmlEntryChunks(readFileSync(html, "utf8")) : [];
  const roots = [...entries, ...[...files].filter((f) => ROOTS.some((re) => re.test(f)))];
  const reached = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (reached.has(file) || !files.has(file)) continue;
    reached.add(file);
    queue.push(...staticImports(readFileSync(join(assetsDir, file), "utf8")));
  }
  const offending = [...reached].filter((f) => FORBIDDEN.test(f));
  return { roots, reached: [...reached], offending };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assetsDir = resolve(process.argv[2] ?? join(HERE, "..", "dist", "assets"));
  if (!existsSync(assetsDir)) {
    console.error(`${assetsDir} does not exist; run the frontend build first.`);
    process.exit(1);
  }
  const { roots, reached, offending } = checkTextEntryChunks(assetsDir);
  const missing = [/^index-/, ...ROOTS].filter((re) => !roots.some((f) => re.test(f)));
  if (missing.length) {
    console.error(`Text mode start chunks not found: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (offending.length) {
    console.error(`Text mode start statically loads map chunks: ${offending.join(", ")}`);
    process.exit(1);
  }
  console.log(`Text mode start: ${reached.length} chunks, none of them map-only.`);
}
