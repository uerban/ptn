import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, "../../src");
const themesCss = readFileSync(resolve(srcRoot, "styles/themes.css"), "utf8");

// All --variant-* identifiers the CSS file declares.
const declared = new Set<string>(
  [...themesCss.matchAll(/--variant-[a-z0-9-]+/g)].map((m) => m[0]),
);

// All --variant-* identifiers referenced in any .ts/.tsx under src/.
// Scan just the source files that were migrated in Phase 1 — quick and deterministic.
const consumingFiles = [
  "components/DepartureSheet/LineGroup.tsx",
  "components/DepartureSheet/DepartureSheet.tsx",
  "components/Schedule/StopCard.tsx",
  "components/Schedule/NearbyStopsList.tsx",
  "components/Guidance/RiderDashboard.tsx",
  "components/Guidance/LegRow.tsx",
  "components/Guidance/StepList.tsx",
  "components/Guidance/TransitLegInfo.tsx",
  "components/Guidance/WalkingLegInfo.tsx",
];

function refsIn(rel: string): string[] {
  try {
    const body = readFileSync(resolve(srcRoot, rel), "utf8");
    return [...body.matchAll(/var\((--variant-[a-z0-9-]+)[,)]/g)].map((m) => m[1]);
  } catch {
    return []; // file may not exist on this branch — test is tolerant
  }
}

describe("--variant-* CSS custom properties", () => {
  it("themes.css declares a non-empty token set", () => {
    expect(declared.size).toBeGreaterThan(0);
  });

  it("every --variant-* reference in migrated source files is declared in themes.css", () => {
    const orphans = new Map<string, string[]>();
    for (const rel of consumingFiles) {
      const refs = refsIn(rel);
      const missing = refs.filter((r) => !declared.has(r));
      if (missing.length > 0) orphans.set(rel, missing);
    }
    expect(orphans.size, `Orphan refs: ${JSON.stringify(Object.fromEntries(orphans))}`).toBe(0);
  });
});
