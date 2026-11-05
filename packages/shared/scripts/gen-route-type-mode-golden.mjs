// Authoritative generator for the route_type→mode golden table.
// Re-run after any change to the mapping:
//   node packages/shared/scripts/gen-route-type-mode-golden.mjs
import { writeFileSync } from "node:fs";

// [lo, hi, MODE] inclusive bands; singletons share the lo==hi form.
const BANDS = [
  [0, 0, "TRAM"], [1, 1, "METRO"], [2, 2, "RAIL"], [3, 3, "BUS"], [4, 4, "FERRY"],
  [5, 5, "CABLE_TRAM"], [6, 6, "AERIAL"], [7, 7, "FUNICULAR"], [11, 11, "TROLLEYBUS"],
  [12, 12, "METRO"],
  [100, 199, "RAIL"], [200, 299, "BUS"], [400, 499, "METRO"], [700, 799, "BUS"],
  [800, 899, "TROLLEYBUS"], [900, 999, "TRAM"], [1000, 1099, "FERRY"],
  [1200, 1299, "FERRY"], [1300, 1399, "AERIAL"], [1400, 1499, "FUNICULAR"],
  [1100, 1199, "OTHER"], [1500, 1599, "OTHER"], [1700, 1799, "OTHER"],
];
function modeOf(rt) {
  for (const [lo, hi, m] of BANDS) if (rt >= lo && rt <= hi) return m;
  return "OTHER";
}
const lines = [];
for (let rt = 0; rt <= 1799; rt++) lines.push(`${rt} ${modeOf(rt)}`);
for (const rt of [1800, 9999, 65535]) lines.push(`${rt} ${modeOf(rt)}`);
const out = new URL("../src/ptb/__fixtures__/route-type-mode.golden.txt", import.meta.url);
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} rows to ${out.pathname}`);
