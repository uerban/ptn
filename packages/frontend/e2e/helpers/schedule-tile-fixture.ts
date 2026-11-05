/**
 * Schedule-tile + rt-tile fixtures for the e2e suite.
 *
 * Why this exists: before it, `e2e/helpers/mock-api.ts` mocked
 * `**\/api/**\/departures*` and had NO handler for `/gtfs/manifest`,
 * `/gtfs/schedule-tile/...` or `/gtfs/rt-tile/...`. Those unmatched requests
 * fell through to the dev server, `resolveDecodedTileForStop` returned
 * `unavailable`, and every departures assertion in the suite silently
 * validated the LEGACY `/api/departures` path — which is not the path
 * production takes. The tile read path had zero browser-level coverage.
 *
 * The tile is built PROGRAMMATICALLY from the same `stops-all.json` fixture the
 * map renders, and encoded with the real `encodeScheduleTile` codec rather than
 * a hand-authored JSON blob, so a wire-format change breaks these fixtures the
 * same way it breaks production instead of leaving them quietly stale. Same
 * reasoning as `mock-api.ts` deriving its raptor-data from the real `tiny.ptb`.
 *
 * Departures are generated RELATIVE TO REQUEST TIME, not module-load time:
 * `getDeparturesFromTile` filters to `[now - 10min, now + lookAheadHours]`, so a
 * tile frozen at import would drift out of that window by the time a slow suite
 * reached the assertion and would produce an empty sheet that looks like a
 * product bug.
 */

import { brotliCompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeScheduleTile } from "../../../shared/src/transit/scheduleTileCodec.ts";
import { scheduleTileCoordAt, SCHEDULE_TILE_SIZE_LABEL } from "../../../shared/src/poi/tileKey.ts";
import type {
  BundleManifest,
  DecodedScheduleTile,
} from "../../../shared/src/types/scheduleTile.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

interface FixtureStop {
  id: string;
  name: string;
  location: { lat: number; lon: number };
  routes?: { id: string; shortName: string; color: string; mode: string }[];
}

const stopsAll = JSON.parse(readFileSync(join(fixturesDir, "stops-all.json"), "utf-8"));
const FIXTURE_STOPS: FixtureStop[] = stopsAll.data ?? stopsAll;

/** Matches the mock backend's city and the tz `getDeparturesFromTile` is given. */
export const FIXTURE_CITY_ID = "vilnius";
export const FIXTURE_TZ = "Europe/Vilnius";

/**
 * Stable bundle hash. MUST be a real 64-character lowercase hex SHA-256 shape:
 * the URL grammar and the read path validate it, so a "readable" placeholder
 * containing non-hex letters is silently rejected and the whole tile path
 * degrades to the legacy fallback — which looks like working software, because
 * the legacy fixture renders perfectly good departures.
 */
export const FIXTURE_BUNDLE_HASH = "e2e0e2e0".repeat(8);

export const SCHEDULE_TILE_SIZE = SCHEDULE_TILE_SIZE_LABEL;

/**
 * Minutes-from-now for each generated departure. Mirrors the offsets baked into
 * `fixtures/departures.json` so assertions written against the legacy fixture
 * keep meaning when the tile path serves them instead.
 */
const DEPARTURE_OFFSETS_MIN = [1, 5, 8, 10, 15, 25];

/**
 * Route short names that appear ONLY on the tile path. `departures.json` uses
 * "1" / "2" / "3G", so seeing these in the DOM proves the tile served.
 */
export const TILE_ROUTE_SHORT_NAMES = ["T1", "T2", "T3"] as const;

/**
 * `T3` carries exactly ONE trip, and the RT overlay always cancels it.
 *
 * This is not arbitrary. The compact stop popup lists a line group's next
 * departures and skips cancelled ones, so a cancellation on a line that also
 * has running trips is merged correctly but never rendered — it just silently
 * disappears from the list. Only a line whose entire visible set is cancelled
 * surfaces the "Cancelled" state, which is how `fixtures/departures.json`
 * happens to exercise it (route 3G has a single, cancelled departure).
 */
export const CANCELLED_ROUTE_SHORT_NAME = "T3";
const CANCELLED_ROUTE_OFFSET_MIN = 12;

/** Headsigns that appear ONLY on the tile path, for the same reason. */
export const TILE_HEADSIGNS = ["Tile Terminus A", "Tile Terminus B"] as const;

/** A headsign that appears ONLY in `departures.json`, never in the tile. */
export const LEGACY_ONLY_HEADSIGN = "Fabijoniškės";

/**
 * RT overlay pattern, by index within each stop's `DEPARTURE_OFFSETS_MIN`.
 * Exported so specs assert against the same numbers the fixture emits rather
 * than hard-coding them twice.
 */
export const DELAYED_TRIP_INDEX = 1; // the +5 min departure
/**
 * The +8 min departure. Deliberately EARLY in the list: the compact stop popup
 * renders only the first few rows per line, so a cancellation placed on the
 * +25 min trip is computed correctly but never reaches the DOM — the assertion
 * then fails for a presentation reason that looks like an RT-merge bug.
 */
export const CANCELLED_TRIP_INDEX = 6;
export const RT_DELAY_SECONDS = 180; // 3 minutes late

/** The cell every fixture stop falls in. They are all within ~1 km of each other. */
export function fixtureTileCoords(): string {
  const first = FIXTURE_STOPS[0];
  const { x, y } = scheduleTileCoordAt(first.location.lat, first.location.lon);
  return `${x}_${y}`;
}

/**
 * Seconds since the city-local midnight of `at`. `departureSecs` in the wire
 * format is base-date relative, so this must be computed in the CITY zone —
 * using the runner's local midnight would shift every departure by the
 * runner-vs-Vilnius offset and silently empty the look-ahead window on any CI
 * box not on Europe/Vilnius.
 */
function citySecondsSinceMidnight(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: FIXTURE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

/** City-local calendar date of `at` as YYYYMMDD, for the calendar row window. */
function cityYmd(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIXTURE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

/**
 * Build a decoded tile whose every fixture stop has one departure per offset.
 *
 * The calendar row runs every weekday and spans a year either side of `now`, so
 * the tile is service-active regardless of when the suite runs — a
 * `no_service_today` result here would be a fixture artefact, not a finding.
 */
export function buildFixtureTile(now: Date = new Date()): DecodedScheduleTile {
  const base = citySecondsSinceMidnight(now);
  const yearMs = 365 * 24 * 3600 * 1000;

  const stringTable: string[] = [];
  const intern = (s: string): number => {
    const at = stringTable.indexOf(s);
    if (at >= 0) return at;
    stringTable.push(s);
    return stringTable.length - 1;
  };

  // Shape per `RouteRow`: `longName` is REQUIRED, `color` is `#RRGGBB` (with
  // the hash), and there is no `textColor` on the tile wire — that lives on the
  // stops/all route payload, not here.
  //
  // Route short names and headsigns are deliberately DISJOINT from
  // `fixtures/departures.json` (which uses "1"/"2"/"3G" and
  // Centras/Fabijoniškės/Pilaitė). Both paths run the same
  // `getDeparturesFromTile` and render identical-looking rows, so identical
  // fixture content would make the two indistinguishable in the DOM — which is
  // precisely how the missing tile coverage stayed invisible. Distinct content
  // lets a spec assert WHICH path served by reading the rendered rows.
  const routes = [
    { id: "r1", shortName: TILE_ROUTE_SHORT_NAMES[0], longName: "Tile Line A", color: "#0073AC", mode: "BUS" as const },
    { id: "r2", shortName: TILE_ROUTE_SHORT_NAMES[1], longName: "Tile Line B", color: "#DC143C", mode: "BUS" as const },
    { id: "r3", shortName: TILE_ROUTE_SHORT_NAMES[2], longName: "Tile Line C", color: "#2E8B57", mode: "BUS" as const },
  ];

  const calendar = [
    {
      serviceId: "e2e-daily",
      days: [true, true, true, true, true, true, true] as [
        boolean, boolean, boolean, boolean, boolean, boolean, boolean,
      ],
      startDate: cityYmd(new Date(now.getTime() - yearMs)),
      endDate: cityYmd(new Date(now.getTime() + yearMs)),
      added: [] as string[],
      removed: [] as string[],
    },
  ];

  const trips: { tripIdIx: number; routeIx: number; serviceIx: number; headsignIx: number }[] = [];
  const stops: Record<string, { tripIxs: Uint32Array; departureSecs: Uint32Array }> = {};

  for (const stop of FIXTURE_STOPS) {
    const tripIxs: number[] = [];
    const secs: number[] = [];
    // T1/T2 alternate across the running departures; T3 is added separately
    // below as the cancelled-only line, so it must NOT be in this rotation.
    DEPARTURE_OFFSETS_MIN.forEach((min, i) => {
      trips.push({
        tripIdIx: intern(`e2e-trip-${stop.id}-${i}`),
        routeIx: i % 2,
        serviceIx: 0,
        headsignIx: intern(TILE_HEADSIGNS[i % TILE_HEADSIGNS.length]),
      });
      tripIxs.push(trips.length - 1);
      secs.push(base + min * 60);
    });

    // The cancelled-only line. Its index is CANCELLED_TRIP_INDEX so
    // buildFixtureRtTile can find it by the same suffix convention.
    trips.push({
      tripIdIx: intern(`e2e-trip-${stop.id}-${CANCELLED_TRIP_INDEX}`),
      routeIx: 2,
      serviceIx: 0,
      headsignIx: intern(TILE_HEADSIGNS[0]),
    });
    tripIxs.push(trips.length - 1);
    secs.push(base + CANCELLED_ROUTE_OFFSET_MIN * 60);

    // departureSecs must stay ascending and parallel to tripIxs, so sort the
    // two together now that the T3 trip was appended out of offset order.
    const order = secs.map((s, i) => i).sort((a, b) => secs[a] - secs[b]);
    const sortedTripIxs = order.map((i) => tripIxs[i]);
    const sortedSecs = order.map((i) => secs[i]);
    tripIxs.length = 0;
    tripIxs.push(...sortedTripIxs);
    secs.length = 0;
    secs.push(...sortedSecs);
    // The codec contract requires departureSecs ascending and parallel to
    // tripIxs; DEPARTURE_OFFSETS_MIN is already ordered, asserted below.
    for (let i = 1; i < secs.length; i++) {
      if (secs[i] < secs[i - 1]) throw new Error("fixture departureSecs must be ascending");
    }
    stops[stop.id] = {
      tripIxs: Uint32Array.from(tripIxs),
      departureSecs: Uint32Array.from(secs),
    };
  }

  return {
    bundleHash: FIXTURE_BUNDLE_HASH,
    cityId: FIXTURE_CITY_ID,
    tileSize: 6000,
    stringTable,
    routes,
    calendar,
    stops,
    trips,
  };
}

/** Brotli-compressed wire bytes, exactly what the route serves. */
export function buildFixtureTileBytes(now: Date = new Date()): Buffer {
  return brotliCompressSync(Buffer.from(encodeScheduleTile(buildFixtureTile(now))));
}

/** Manifest advertising the fixture bundle with no subdivided cells. */
export function buildFixtureManifest(): BundleManifest {
  return {
    schemaVersion: 1,
    bundleHash: FIXTURE_BUNDLE_HASH,
    generatedAt: Date.now(),
    tileSize: 6000,
  } as BundleManifest;
}

/**
 * Live RT overlay for the fixture tile.
 *
 * Without this the tile path could only ever render schedule-only rows, so the
 * RT-dependent UI states (LIVE badge, cancelled strikethrough,
 * predicted-vs-scheduled) were coverable only through the legacy fixture — i.e.
 * on the path production does NOT take.
 *
 * The overlay is keyed by bare `tripId`, matching how the read path builds its
 * map when the feed sets no `start_date`
 * (`scheduleTileReadPath.ts:221-224` — a `startDate` would make the key
 * `tripId|startDate` and silently miss every trip here).
 *
 * The pattern is applied by trip INDEX so it holds for every stop uniformly:
 * one delayed trip and one cancelled trip per stop, mirroring the states
 * `fixtures/departures.json` carries for the legacy path.
 */
export function buildFixtureRtTile(): RtTileFixture {
  const tile = buildFixtureTile();
  const trips = tile.trips.map((trip) => {
    const tripId = tile.stringTable[trip.tripIdIx];
    const index = Number(tripId.slice(tripId.lastIndexOf("-") + 1));
    return {
      tripId,
      delaySeconds: index === DELAYED_TRIP_INDEX ? RT_DELAY_SECONDS : 0,
      cancelled: index === CANCELLED_TRIP_INDEX,
    };
  });
  return { bundleHash: FIXTURE_BUNDLE_HASH, generatedAt: Date.now(), trips };
}

export interface RtTileFixture {
  bundleHash: string;
  generatedAt: number;
  trips: { tripId: string; delaySeconds: number; cancelled: boolean }[];
}
