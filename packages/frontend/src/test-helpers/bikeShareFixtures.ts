// Shared scaffolding for the bike-share test suites (store, layer, toggle,
// sheet). Lives under src/ rather than tests/helpers/ because those suites
// are colocated with their subjects inside tsconfig's `rootDir: ./src`, and
// tsc rejects imports from outside the root (TS6059). Not a test file —
// vitest's include pattern only collects *.test.* — and nothing in the
// production import graph reaches it.
import { vi } from "vitest";
import type { CityConfig, SharedMobilitySystem } from "../config/cities.ts";

/**
 * Canonical test operator, mirroring the shape of the production `vilnius`
 * Cyclocity entry (id/name/https discovery URL) without hitting the real
 * host. Shared by the bike-share store, toggle, and sheet suites.
 */
export const cyclocity: SharedMobilitySystem = {
  id: "cyclocity",
  name: "Cyclocity Vilnius",
  gbfsDiscoveryUrl: "https://example.test/vilnius/gbfs.json",
};

/**
 * Minimal valid CityConfig for bike-share tests. Omit `systems` for a city
 * with no shared-mobility config (the field is absent, not an empty array);
 * pass an array to opt the city in.
 */
export function makeCity(
  id: string,
  systems?: readonly SharedMobilitySystem[],
): CityConfig {
  return {
    id,
    name: id,
    center: { lat: 54.68, lon: 25.27 },
    bbox: { minLat: 54.6, minLon: 25.1, maxLat: 54.8, maxLon: 25.5 },
    available: true,
    tz: "Europe/Vilnius",
    ...(systems !== undefined ? { sharedMobility: systems } : {}),
  };
}

/**
 * `vi.mock` module factory for `src/db/index.ts` in bike-share component
 * tests: bikeShareStore pulls the Dexie helpers in at module load, but the
 * components under test only read store state, so the helpers are stubbed
 * away to keep those suites hermetic.
 *
 * The `vi.mock` call itself MUST stay in each test file — vitest hoists
 * mocks per-file and only scans the test file for them — but the factory
 * body can live here because mock factories are invoked lazily:
 *
 *   vi.mock("../../db/index.ts", async () =>
 *     (await import("../../test-helpers/bikeShareFixtures.ts")).stubGbfsDb(),
 *   );
 *
 * Tests that need to configure or assert on these mocks (the store suite)
 * should keep their own `vi.hoisted` mock set instead.
 */
export function stubGbfsDb() {
  return {
    readGbfsSystem: vi.fn(async () => undefined),
    writeGbfsSystem: vi.fn(async () => {}),
  };
}
