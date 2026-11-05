// Pin TZ before any imports so ymdLocal (which uses local-time Date getters)
// is deterministic regardless of the runner's system zone.
process.env.TZ = "Europe/Paris";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL, encodeScheduleTile, getDeparturesFromTile,
  type DecodedScheduleTile,
} from "@pt/shared";
import { compressTileBytes } from "../gtfs/scheduleTileBrotli.js";
import { createRtTileHandler } from "./rtTile.js";
import { GtfsStore } from "../gtfs/store.js";

const HASH = "a".repeat(64);

/**
 * A tile with three trips at stop S1:
 *   T1  — normal trip, departureSecs=28800 (08:00), bare RT entry.
 *   TP  — pass-through trip (G1 divergence), departureSecs=30600 (08:30), bare RT entry.
 *   TN  — overnight trip (G2 divergence), departureSecs=90000 (25h → 01:00 next wall-clock
 *          day from the base date). Has both a bare RT entry AND date-scoped entries.
 *
 * With now = 2026-06-11 12:00 Paris (CEST=UTC+2):
 *   - today base    (20260611): T1 at 08:00 is behind the 10-min lower cutoff (11:50) ✗
 *                               TP at 08:30 is behind the 10-min lower cutoff (11:50) ✗
 *                               TN fires at 2026-06-12 01:00 → in window ✓ (TN|20260611 hit)
 *   - tomorrow base (20260612): T1 at 08:00, TP at 08:30 → in window ✓ (bare T1/TP keys)
 *   Wait — TN from 20260611 base: 90000 s after midnight = 01:00 on 06-12 → in window ✓.
 *   The merge looks up TN|20260611 first → delaySeconds 300 (distinct from bare 30).
 *
 * Calendar: serviceId "WD" active every day 2026-06-01..2026-06-30.
 * days = [mon,tue,wed,thu,fri,sat,sun] = all true.
 * 2026-06-11 (Thursday, dayIx=3) and 2026-06-12 (Friday, dayIx=4) are both active.
 */
function fixtureTile(): DecodedScheduleTile {
  return {
    bundleHash: HASH,
    cityId: "vilnius",
    tileSize: 12000,
    stringTable: ["T1", "TP", "TN", "Downtown"],
    routes: [{ id: "R1", shortName: "1", longName: "Line", color: "#FF0000", mode: "BUS" }],
    calendar: [
      {
        serviceId: "WD",
        startDate: "20260601",
        endDate: "20260630",
        days: [true, true, true, true, true, true, true],
        added: [],
        removed: [],
      },
    ],
    trips: [
      { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // T1
      { tripIdIx: 1, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // TP
      { tripIdIx: 2, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // TN
    ],
    stops: {
      S1: {
        tripIxs: new Uint32Array([0, 1, 2]),
        // 28800=08:00, 30600=08:30, 90000=25h (overnight, rolls to 01:00 on the next calendar day)
        departureSecs: new Uint32Array([28800, 30600, 90000]),
      },
    },
  };
}

describe("rt-tile fidelity: client-rebuilt-from-wire == backend snapshot overlay", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ptn-rtfid-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("produces identical Departure[] for normal, pass-through, and overnight trips", async () => {
    const { scheduleTileCoordAt } = await import("@pt/shared");
    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const coords = `${cell.x}_${cell.y}`;
    const tile = fixtureTile();

    mkdirSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(
      join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, `${coords}.br`),
      await compressTileBytes(encodeScheduleTile(tile)),
    );

    // The backend RT snapshot: dual keys (bare + date-scoped), as the poller stores.
    // TN has bare + two date-scoped entries to exercise the G2 divergence.
    const snapshot = new Map([
      ["T1",         { delaySeconds: 60,  cancelled: false }],
      ["TP",         { delaySeconds: 120, cancelled: false }],
      ["TN",         { delaySeconds: 30,  cancelled: false }],
      ["TN|20260611", { delaySeconds: 300, cancelled: false }],
      ["TN|20260612", { delaySeconds: 600, cancelled: false }],
    ]);

    // Client side: serve the rt-tile via a real GtfsStore, then rebuild the
    // realtimeUpdates map from the rt-tile WIRE. The wire carries one entry per
    // rtEntriesForTrip result; startDate (when present) becomes the pipe suffix
    // in the reconstructed key — exactly mirroring the backend snapshot shape.
    const store = new GtfsStore();
    store.setRealtimeUpdates(snapshot);

    // Backend side uses the REAL production transform — rtUpdatesSnapshot() —
    // not a hand-built map. This is a genuine differential: the backend uses the
    // same code path as production; the client rebuilds from the wire. Any
    // divergence in key construction or tripId extraction is caught here.
    const backendMap = store.rtUpdatesSnapshot();

    const app: FastifyInstance = Fastify({ logger: false });
    app.get(
      "/api/gtfs/rt-tile/:bundleHash/:tileSize/:tileCoords",
      createRtTileHandler({
        dataDir,
        cityId: "vilnius",
        getCurrentBundleHash: () => HASH,
        getRtEntriesForTrip: (id) => store.rtEntriesForTrip(id),
        getManifestSnapshot: () => null,
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/${coords}`,
    });
    expect(res.statusCode).toBe(200);

    const wire = JSON.parse(res.payload).trips as Array<{
      tripId: string;
      startDate?: string;
      delaySeconds: number;
      cancelled: boolean;
    }>;

    // Rebuild the client's realtimeUpdates from the wire: startDate present →
    // `${tripId}|${startDate}` key; absent → bare tripId key. Values carry
    // tripId (to match the backend map shape) but NOT startDate (it's not a
    // field on RtTripUpdate that getDeparturesFromTile reads).
    const clientMap = new Map(
      wire.map((t) => [
        t.startDate !== undefined ? `${t.tripId}|${t.startDate}` : t.tripId,
        { tripId: t.tripId, delaySeconds: t.delaySeconds, cancelled: t.cancelled },
      ]),
    );

    // now = 2026-06-11 12:00 Paris (CEST = UTC+2).
    // Lower cutoff: 11:50. Upper cutoff: 2026-06-12 12:00.
    // In-window departures:
    //   TN from base 20260611: midnight + 90000s = 2026-06-12 01:00 ✓ (uses TN|20260611 key → delay 300)
    //   T1 from base 20260612: midnight + 28800s = 2026-06-12 08:00 ✓ (uses bare T1 key)
    //   TP from base 20260612: midnight + 30600s = 2026-06-12 08:30 ✓ (uses bare TP key)
    const now = new Date("2026-06-11T12:00:00+02:00");

    const backend = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 100,
      lookAheadHours: 24,
      realtimeUpdates: backendMap as any,
    });
    const client = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 100,
      lookAheadHours: 24,
      realtimeUpdates: clientMap as any,
    });

    // Core assertion: wire-rebuilt overlay produces bit-identical Departure[].
    // Do NOT weaken this to a subset check — identical output is the whole point of Stage A.
    expect(client.departures).toEqual(backend.departures);

    // Sanity: non-empty — both the pass-through trip (TP, G1) and overnight trip
    // (TN, G2) must appear with predictedTime (their delays are non-zero).
    expect(client.departures.length).toBeGreaterThanOrEqual(2);
    expect(client.departures.some((d) => d.tripId === "TP" && d.predictedTime !== undefined)).toBe(true);
    expect(client.departures.some((d) => d.tripId === "TN" && d.predictedTime !== undefined)).toBe(true);

    // Date-scoped path pin: TN's in-window departure comes from base 20260611 at
    // noon, so the merge hits TN|20260611 (delaySeconds 300), NOT the bare TN
    // entry (delaySeconds 30). This assertion fails if startDate is dropped from
    // the wire or if the date-scoped lookup path is bypassed.
    const tn = client.departures.find((d) => d.tripId === "TN");
    expect(tn?.delaySeconds).toBe(300);
  });
});
