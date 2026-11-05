#!/usr/bin/env node
// Write the e2e catalog fixture as a GTFS feed.
//
//   node catalog-gtfs.mjs <out-dir> [--shapeless]
//
// `raptor-data.json` is the wire-shaped topology every @mock-api spec asserts
// on. The harness serves it as PTB bytes the Rust producer builds from the
// feed this script writes (see `regen-catalog-ptb.sh`), so the browser's real
// read path sees exactly what production sends.
//
// One deliberate divergence from the JSON: a `directionPattern` that no trip
// serves cannot survive as a pattern, because the catalog derives patterns by
// bucketing trips on `(direction_id, headsign)`. The fixture has exactly one
// such pattern (route `1`'s inbound leg through the return-only stop), so this
// synthesises inbound trips for it on the same departure grid as the outbound
// ones, offset by 30 minutes. That is also what a real feed looks like.
//
// `--shapeless` omits every trip's shape_id: the feed a city without
// shapes.txt produces.
//
// GTFS reference: https://gtfs.org/documentation/schedule/reference/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shapeless = args.includes("--shapeless");
const outDir = args.find((a) => a !== "--shapeless");
if (!outDir) {
  console.error("usage: catalog-gtfs.mjs <out-dir> [--shapeless]");
  process.exit(2);
}

const wire = JSON.parse(readFileSync(join(here, "raptor-data.json"), "utf8"));

/** GTFS `route_type` per wire mode. An unknown mode is a fixture error. */
const ROUTE_TYPE_BY_MODE = { TRAM: 0, METRO: 1, RAIL: 2, BUS: 3, FERRY: 4, TROLLEYBUS: 11 };

/** RFC 4180 field: quote when the value has a comma, quote, or newline. */
function field(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function csv(header, rows) {
  return [header, ...rows].map((r) => r.map(field).join(",")).join("\n") + "\n";
}
/** Seconds after midnight → GTFS `HH:MM:SS` (hours may exceed 23). */
function hms(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

const trips = [];
for (const route of wire.routes) {
  if (ROUTE_TYPE_BY_MODE[route.mode] === undefined) {
    throw new Error(`catalog fixture: route ${route.id} has unmapped mode ${route.mode}`);
  }
  const patterns = route.directionPatterns ?? [];
  // Which pattern a trip belongs to is decided by headsign, the same key the
  // catalog buckets on when it derives them back out.
  const patternFor = (headsign) => {
    const idx = patterns.findIndex((p) => p.headsign === headsign);
    if (idx >= 0) return { stopIds: patterns[idx].stopIds, directionId: idx === 0 ? 0 : 1 };
    return { stopIds: route.stopIds, directionId: 0 };
  };
  for (const trip of route.trips) {
    const { stopIds, directionId } = patternFor(trip.headsign);
    // `departureSecs` is authored 1:1 with the pattern it serves; refuse a
    // misaligned edit rather than emit a feed that loads and is wrong.
    if (trip.departureSecs.length < stopIds.length) {
      throw new Error(
        `catalog fixture: trip ${trip.tripId} has ${trip.departureSecs.length} departures ` +
          `for a ${stopIds.length}-stop pattern`,
      );
    }
    trips.push({
      tripId: trip.tripId,
      routeId: route.id,
      serviceId: trip.serviceId,
      headsign: trip.headsign,
      directionId,
      shapeId: trip.shapeId ?? "",
      seq: stopIds.map((stopId, i) => ({ stopId, depSecs: trip.departureSecs[i] })),
    });
  }
  // Synthesise trips for any pattern no trip serves (see the header comment).
  for (const [i, pattern] of patterns.entries()) {
    if (route.trips.some((t) => t.headsign === pattern.headsign)) continue;
    for (const [n, donor] of route.trips.entries()) {
      const base = donor.departureSecs[0] ?? n * 3600;
      trips.push({
        tripId: `${route.id}-rev-${String(n).padStart(2, "0")}`,
        routeId: route.id,
        serviceId: donor.serviceId,
        headsign: pattern.headsign,
        directionId: i === 0 ? 0 : 1,
        shapeId: donor.shapeId ?? "",
        seq: pattern.stopIds.map((stopId, k) => ({ stopId, depSecs: base + 1800 + k * 600 })),
      });
    }
  }
}

const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const files = {
  "agency.txt": csv(
    ["agency_id", "agency_name", "agency_url", "agency_timezone"],
    [["fixture", "Fixture", "https://example.com", "Europe/Vilnius"]],
  ),
  "stops.txt": csv(
    ["stop_id", "stop_name", "stop_lat", "stop_lon"],
    wire.stops.map((s) => [s.id, s.name, s.lat, s.lon]),
  ),
  "routes.txt": csv(
    ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"],
    wire.routes.map((r) => [
      r.id,
      "fixture",
      r.shortName,
      "",
      ROUTE_TYPE_BY_MODE[r.mode],
      r.color ?? "",
      r.textColor ?? "",
    ]),
  ),
  "calendar.txt": csv(
    ["service_id", ...days, "start_date", "end_date"],
    wire.calendar.map((c) => [
      c.serviceId,
      ...c.days.map((d) => (d ? 1 : 0)),
      c.startDate,
      c.endDate,
    ]),
  ),
  "trips.txt": csv(
    ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
    trips.map((t) => [t.routeId, t.serviceId, t.tripId, t.headsign, t.directionId, shapeless ? "" : t.shapeId]),
  ),
  "stop_times.txt": csv(
    ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
    trips.flatMap((t) =>
      t.seq.map((row, i) => [t.tripId, hms(row.depSecs), hms(row.depSecs), row.stopId, i + 1]),
    ),
  ),
};

mkdirSync(outDir, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(outDir, name), text);
