import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Strip line + block comments before the CityProfile symbol sweep. The ban is on
// a CODE reference to the `CityProfile` symbol (import / type / identifier use),
// NOT on the word appearing in prose — config/cities.ts documents its
// frontend-only `geocoder` field by explicitly contrasting it with the backend
// `CityProfile.geocoder`, which is a deliberate disambiguation comment, not a
// reference. Deviation from the plan's raw-source regex (noted): the plan code
// ran `/\bCityProfile\b/` over the whole file, which false-positives on that
// comment; stripping comments preserves the guard's intent (any real symbol use
// still fails) without flagging documentation.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, ""); // line comments
}

// CityProfile ban-list: every Phase-3 frontend module that touches config or
// geocoder wiring. The test file lives at src/services/, so paths are relative
// to that dir — bootPoi.ts is one level up (../bootPoi.ts). bootPoi.ts is a new
// Phase-3 module that reads CityConfig.geocoder + wires the geocoder lifecycle,
// so it MUST be in the CityProfile sweep (Must-fix 9).
const PHASE3_FILES = [
  "./geocoder/registerSelfHosted.ts",
  "./poiFetchMode.ts",
  "./poiSync.ts",
  "./geocoder/registry.ts",
  "../config/cities.ts",
  "../bootPoi.ts",
];

describe("AC-9 — no CityProfile symbol in Phase-3 frontend modules", () => {
  for (const rel of PHASE3_FILES) {
    it(`${rel} does not reference the CityProfile symbol`, () => {
      const src = stripComments(read(rel));
      // Word-boundary match on the symbol name — tolerant of import lists and
      // type positions, but does NOT false-positive on SelfHostedGeocoderConfig.
      expect(/\bCityProfile\b/.test(src)).toBe(false);
    });
  }
});

describe("AC-5e — loadPoiBundle is the sole caller of fetchPoiBundle", () => {
  it("fetchPoiBundle is called only inside poiLoader.ts (loadPoiBundle)", () => {
    const loader = read("./poiLoader.ts");
    // Inside poiLoader.ts, the only call sites are within loadPoiBundle (strict +
    // loose). No other module imports/calls fetchPoiBundle for a corpus fetch.
    const callsInLoader = (loader.match(/fetchPoiBundle\(/g) ?? []).length;
    expect(callsInLoader).toBeGreaterThanOrEqual(2); // strict + loose call sites

    // bootPoi.ts is EXCLUDED from this ban: it legitimately calls loadBundle →
    // loadPoiBundle (the corpus-fetch entry point) but NEVER fetchPoiBundle
    // directly. The ban is on a SECOND fetchPoiBundle call site, not on the
    // loadPoiBundle wiring (Must-fix 9).
    for (const rel of ["./poiSync.ts", "./geocoder/registerSelfHosted.ts", "./poiFetchMode.ts"]) {
      const src = read(rel);
      expect(/fetchPoiBundle\(/.test(src)).toBe(false);
    }
  });
});
