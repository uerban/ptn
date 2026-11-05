import { unzipSync } from "fflate";
import {
  parseStops,
  parseRoutes,
  parseTrips,
  parseStopTimes,
  parseCalendar,
  parseCalendarDates,
  parseShapes,
} from "../../src/gtfs/parser.js";
import { buildIndexes } from "../../src/gtfs/index-builder.js";
import { buildShapesIndex } from "../../src/gtfs/shapesIndex.js";
import { readCaps } from "../../src/gtfs/caps.js";
import { shapesEnabled } from "../../src/gtfs/loader.js";
import { GtfsStore } from "../../src/gtfs/store.js";

/**
 * Test-only GTFS ingest harness.
 *
 * Replicates the minimum of `loader.ts`'s ingest pipeline from a raw zip
 * buffer in memory — HTTP fetching, caps enforcement, multi-feed merge, and
 * streaming stop_times parsing are deliberately skipped because tests don't
 * need them and the streaming path is tied to a Node I/O loop that's awkward
 * to drive from a sync `Uint8Array`.
 *
 * The harness mirrors the loader's feature-flag gating (`PT_FEATURE_SHAPES`)
 * so smoke tests can assert that shape-related state really vanishes when the
 * flag is off.
 *
 * Use only from tests. Real ingest goes through `loadGtfs`.
 */
export async function makeFixtureStore(zipBytes: Uint8Array): Promise<GtfsStore> {
  const shapesOn = shapesEnabled();
  const files = unzipSync(zipBytes);

  const empty = new Uint8Array(0);
  const get = (name: string): Uint8Array => files[name] ?? empty;

  const [stops, routes, trips, stopTimes, calendar, calendarDates, shapePoints] =
    await Promise.all([
      parseStops(get("stops.txt")),
      parseRoutes(get("routes.txt")),
      parseTrips(get("trips.txt")),
      parseStopTimes(get("stop_times.txt")),
      parseCalendar(get("calendar.txt")),
      parseCalendarDates(get("calendar_dates.txt")),
      shapesOn ? parseShapes(get("shapes.txt")) : Promise.resolve([]),
    ]);

  // Mirror loader.ts: when shapes are disabled, wipe `shapeId` off trips so
  // nothing downstream retains a reference to a shape we aren't ingesting.
  if (!shapesOn) {
    for (const t of trips) t.shapeId = undefined;
  }

  // Build routing indexes via the array-path builder — it's the simplest
  // entry point that produces a fully-formed `{ indexes, canonical,
  // routingInput }` tuple matching what `GtfsStore.swap` expects.
  const { indexes, canonical, routingInput } = buildIndexes(
    stops,
    routes,
    trips,
    stopTimes,
    calendar,
    calendarDates,
    /* minTripsPerRoute */ 0,
  );

  const store = new GtfsStore(indexes, canonical, routingInput, 0);

  // Shape indexing + orphan-trip stripping only when the flag is on.
  // When off, we deliberately skip `setShapes` so the store's pristine
  // shape state (empty arrays, empty body, empty hash) is preserved —
  // that's what the `noShapes` smoke test asserts.
  if (shapesOn && shapePoints.length > 0) {
    const caps = readCaps();
    const { shapes } = buildShapesIndex({
      shapePoints,
      trips,
      caps: {
        shapesCount: caps.shapesCount,
        pointsPerShape: caps.pointsPerShape,
        shapesEncodedBytes: caps.shapesEncodedBytes,
      },
    });

    // If `buildShapesIndex` dropped a shape (over caps), trips that still
    // reference it would serialize a `shapeId` the client can't resolve.
    // Strip those orphan references.
    const keptIds = new Set(shapes.map((s) => s.shapeId));
    for (const t of trips) {
      if (t.shapeId && !keptIds.has(t.shapeId)) t.shapeId = undefined;
    }

    store.setShapes(shapes);
  }

  return store;
}
