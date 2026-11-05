// Guards the e2e harness's catalog fixture. `catalog.ptb` is the Rust
// producer's build of the wire-shaped `raptor-data.json`, re-anchored to the
// day the harness runs; if the committed bytes drift from the JSON the specs
// assert on, every @mock-api spec fails at once with a symptom (empty stop
// list, missing route) that points nowhere near the fixture. These assertions
// fail here instead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { decodePtbCatalog } from "../../src/services/ptbCatalogDecode.ts";
import { anchorCatalogPtb, type CatalogShapes } from "../../e2e/fixtures/catalogPtb.ts";
// Imported, not read relative to this file: this suite runs under jsdom, where
// `import.meta.url` is not a file: URL. Vitest runs from the package root.
import fixtureJson from "../../e2e/fixtures/raptor-data.json";

const CATALOG_FILES: Record<CatalogShapes, string> = {
  advertised: "e2e/fixtures/catalog.ptb",
  absent: "e2e/fixtures/catalog-shapeless.ptb",
};

interface WireCatalog {
  stops: Array<{ id: string; name: string; lat: number; lon: number }>;
  routes: Array<{
    id: string;
    shortName: string;
    mode: string;
    trips: Array<{ tripId: string; shapeId?: string }>;
  }>;
}
const FIXTURE = fixtureJson as unknown as WireCatalog;

// A fixed instant so the assertions do not depend on the day the suite runs.
// The harness itself passes no clock, which is the point — see the builder.
const NOW = new Date("2026-08-12T09:00:00Z");

/**
 * Decode through `decodePtbCatalog` — the exact function the browser's worker
 * calls — so a change to the production decode options (pattern mode,
 * direction patterns) fails here rather than only in a browser run.
 */
function wireFromFixture(shapes: CatalogShapes = "advertised") {
  const bytes = anchorCatalogPtb(readFileSync(resolve(process.cwd(), CATALOG_FILES[shapes])), {
    now: NOW,
  });
  return decodePtbCatalog(bytes, {
    cityId: "vilnius",
    generation: {
      generationId: "0".repeat(64),
      generatedAt: NOW.toISOString(),
      cityTzIana: "Europe/Vilnius",
    },
  });
}

describe("e2e catalog fixture → PTB", () => {
  it("round-trips every stop with its name and position", () => {
    const wire = wireFromFixture();
    expect(wire.stops.map((s) => s.id).sort()).toEqual(
      FIXTURE.stops.map((s) => s.id).sort(),
    );
    const seskines = wire.stops.find((s) => s.id === "vilnius-seskinespoliklinika");
    expect(seskines?.name).toBe("Šeškinės poliklinika");
    // Coordinates survive PTB's quantisation closely enough for the map specs,
    // which assert on marker positions.
    expect(seskines?.lat).toBeCloseTo(54.7155, 4);
    expect(seskines?.lon).toBeCloseTo(25.2471, 4);
  });

  it("round-trips every route with its short name, mode and colour", () => {
    const wire = wireFromFixture();
    const byId = new Map(wire.routes.map((r) => [r.id, r]));
    for (const route of FIXTURE.routes) {
      const got = byId.get(route.id);
      expect(got, `route ${route.id} missing`).toBeDefined();
      expect(got!.shortName).toBe(route.shortName);
      expect(got!.mode).toBe(route.mode);
    }
    expect(byId.get("test-route-1")!.color).toBe("0073AC");
    // The TRAM chips the mode-badge specs assert on.
    expect(byId.get("r4")!.mode).toBe("TRAM");
  });

  it("gives the return-only stop an inbound pattern backed by real trips", () => {
    const wire = wireFromFixture();
    // Under Unbounded pattern mode the wire carries one entry per pattern, so
    // collect across entries the way `aggregateDisplayRoutes` does.
    const patterns = wire.routes
      .filter((r) => r.id === "test-route-1")
      .flatMap((r) => r.directionPatterns ?? []);
    // Every per-pattern entry repeats the route's full pattern list, which is
    // why `aggregateDisplayRoutes` dedups on (key, headsign) before display.
    const headsigns = [...new Set(patterns.map((p) => p.headsign))].sort();
    expect(headsigns).toEqual(["Alpha Terminal", "Bravo Center"]);

    const inbound = patterns.find((p) => p.headsign === "Alpha Terminal")!;
    expect(inbound.stopIds).toEqual(["test-B", "test-X", "test-A"]);
  });

  it("serves departures on the day it is built", () => {
    const wire = wireFromFixture();
    const anyTrips = wire.routes.some((r) => (r.trips?.length ?? 0) > 0);
    expect(anyTrips).toBe(true);
    // A v2 catalog is used as built (its service-day origins are fixed, so its
    // header cannot be re-anchored). Its window starts 20251230 and covers the
    // day the specs run, so the committed bytes never go dark.
    const calendar = wire.calendar ?? [];
    expect(calendar.length).toBeGreaterThan(0);
    expect(calendar[0]!.startDate <= "20260812").toBe(true);
    expect(calendar[0]!.days.every(Boolean)).toBe(true);
  });

  it("carries trip shape ids only in the advertised build", () => {
    const shapeIds = (shapes: CatalogShapes) =>
      new Set(
        wireFromFixture(shapes)
          .routes.flatMap((r) => r.trips ?? [])
          .map((t) => t.shapeId ?? ""),
      );
    expect(shapeIds("advertised")).toContain("3G-shape");
    expect([...shapeIds("absent")].filter(Boolean)).toEqual([]);
  });
});
