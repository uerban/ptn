import type {
  DecodedScheduleTile,
  CalendarRow,
  DaysOfWeek,
  RouteRow,
  TileTripRow,
} from "../types/scheduleTile.js";

/**
 * Wire-format version. Bumped only when the JSON schema changes in a way
 * that older decoders cannot read. Bumps automatically invalidate the
 * bundleHash because `computeBundleHash` includes this constant directly
 * in its canonical input — no manual co-bump of
 * `GET_DEPARTURES_FROM_TILE_VERSION` is required.
 */
export const SCHEDULE_TILE_WIRE_VERSION = 1;

/**
 * Wire-format calendar row. Internal — not exported. Distinct from
 * `CalendarRow` because `JSON.parse` produces `boolean[]` for `days`, not the
 * fixed-arity `DaysOfWeek` 7-tuple. The decoder validates length and casts
 * once at the boundary; the rest of the codebase keeps the tuple invariant.
 */
interface WireCalendarRow {
  serviceId: string;
  days: boolean[];
  startDate: string;
  endDate: string;
  added: string[];
  removed: string[];
}

/** v1 wire-format JSON shape. Internal — do not import outside the codec. */
interface WireScheduleTileV1 {
  v: 1;
  bundleHash: string;
  cityId: string;
  tileSize: number;
  stringTable: string[];
  routes: RouteRow[];
  calendar: WireCalendarRow[];
  trips: TileTripRow[];
  /** Stops as plain arrays of numbers (typed arrays don't JSON-stringify cleanly). */
  stops: Record<string, { tripIxs: number[]; departureSecs: number[] }>;
}

/**
 * Encode a `DecodedScheduleTile` to a UTF-8 JSON byte stream (v1 wire format).
 * The output is uncompressed; a brotli wrapper sits above this.
 *
 * Typed-array conversion: `Uint32Array` values in `stops[*]` become plain
 * `number[]` on the wire (JSON.stringify of a typed array produces an object
 * form, not an array; so we materialise plain arrays before encoding).
 */
export function encodeScheduleTile(tile: DecodedScheduleTile): Uint8Array {
  const wireStops: WireScheduleTileV1["stops"] = {};
  for (const [stopId, columns] of Object.entries(tile.stops)) {
    wireStops[stopId] = {
      tripIxs: Array.from(columns.tripIxs),
      departureSecs: Array.from(columns.departureSecs),
    };
  }

  const wire: WireScheduleTileV1 = {
    v: SCHEDULE_TILE_WIRE_VERSION,
    bundleHash: tile.bundleHash,
    cityId: tile.cityId,
    tileSize: tile.tileSize,
    stringTable: [...tile.stringTable],
    routes: [...tile.routes],
    calendar: tile.calendar.map((c) => ({
      serviceId: c.serviceId,
      days: [...c.days],
      startDate: c.startDate,
      endDate: c.endDate,
      added: [...c.added],
      removed: [...c.removed],
    })),
    trips: [...tile.trips],
    stops: wireStops,
  };

  return new TextEncoder().encode(JSON.stringify(wire));
}

/**
 * Decode a v1 JSON byte stream back to a `DecodedScheduleTile`. Thin wrapper
 * over {@link decodeScheduleTileFromText}; all validation lives there.
 *
 * Does NOT validate that `bundleHash` matches a route URL — that's the route
 * handler's concern.
 *
 * @see decodeScheduleTileFromText for the validation contract.
 */
export function decodeScheduleTile(bytes: Uint8Array): DecodedScheduleTile {
  return decodeScheduleTileFromText(new TextDecoder().decode(bytes));
}

/**
 * Decode a v1 JSON tile from an already-decoded UTF-8 string.
 *
 * Convenience entry point for callers that already hold the decoded text
 * (e.g. a frontend brotli-decompression worker that returns `Promise<string>`).
 * Skips the redundant `string → Uint8Array → string` round-trip that
 * `decodeScheduleTile` would otherwise force.
 *
 * Validates structural shape: the `v` discriminant alone is insufficient
 * because a stale or partial v1 payload may parse as JSON without the
 * required fields. Missing fields would otherwise propagate as `undefined`
 * into the typed return value and break consumers cryptically. Each top-level
 * required field is checked here, plus per-stop column shape and parallel-
 * array length, plus `calendar[*].days.length === 7`. Errors name the
 * offending field/stopId/calendar index so the message points at the codec.
 *
 * @see decodeScheduleTile for the byte-input wrapper.
 */
export function decodeScheduleTileFromText(text: string): DecodedScheduleTile {
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("scheduleTileCodec: parsed JSON is not an object");
  }
  const wire = parsed as Partial<WireScheduleTileV1>;

  if (wire.v !== SCHEDULE_TILE_WIRE_VERSION) {
    throw new Error(
      `scheduleTileCodec: unsupported wire version ${wire.v} ` +
      `(this build understands v${SCHEDULE_TILE_WIRE_VERSION})`,
    );
  }

  for (const field of ["stringTable", "routes", "calendar", "trips"] as const) {
    if (!Array.isArray(wire[field])) {
      throw new Error(
        `scheduleTileCodec: wire field "${field}" is missing or not an array ` +
        `(got ${typeof wire[field]})`,
      );
    }
  }
  if (
    typeof wire.stops !== "object" ||
    wire.stops === null ||
    Array.isArray(wire.stops)
  ) {
    throw new Error(`scheduleTileCodec: wire field "stops" is missing or not an object`);
  }
  if (typeof wire.bundleHash !== "string") {
    throw new Error(`scheduleTileCodec: wire field "bundleHash" is missing or not a string`);
  }
  if (typeof wire.cityId !== "string") {
    throw new Error(`scheduleTileCodec: wire field "cityId" is missing or not a string`);
  }
  if (typeof wire.tileSize !== "number") {
    throw new Error(`scheduleTileCodec: wire field "tileSize" is missing or not a number`);
  }

  // The validation block above proves every required field is present and
  // structurally valid. Narrow `wire` from `Partial<WireScheduleTileV1>` to
  // the full shape so the rest of the function doesn't carry non-null
  // assertions on each access. TypeScript can't infer this through the loop
  // and the multi-step guards.
  const validated = wire as WireScheduleTileV1;

  const stops: Record<string, { tripIxs: Uint32Array; departureSecs: Uint32Array }> = {};
  for (const [stopId, columns] of Object.entries(validated.stops)) {
    if (
      typeof columns !== "object" ||
      columns === null ||
      !Array.isArray(columns.tripIxs) ||
      !Array.isArray(columns.departureSecs)
    ) {
      // Without this guard a malformed `columns` falls through to
      // `Uint32Array.from(undefined)` (TypeError without stopId context)
      // or `Uint32Array.from("hello")` (silent zero-padded typed array).
      throw new Error(
        `scheduleTileCodec: stops["${stopId}"] is malformed — ` +
          `expected { tripIxs: number[], departureSecs: number[] }`,
      );
    }
    if (columns.tripIxs.length !== columns.departureSecs.length) {
      throw new Error(
        `scheduleTileCodec: stops["${stopId}"] parallel arrays have mismatched lengths ` +
          `(tripIxs: ${columns.tripIxs.length}, departureSecs: ${columns.departureSecs.length})`,
      );
    }
    stops[stopId] = {
      tripIxs: Uint32Array.from(columns.tripIxs),
      departureSecs: Uint32Array.from(columns.departureSecs),
    };
  }

  // Reconstruct the `DaysOfWeek` tuple. GTFS calendar.txt always carries
  // 7 day columns, so a non-7 length here means a malformed wire payload
  // (or a corrupted producer). Fail loud rather than letting an off-length
  // array propagate into the consumer with type that lies about its shape.
  const calendar: CalendarRow[] = validated.calendar.map((c, ix) => {
    if (!Array.isArray(c.days) || c.days.length !== 7) {
      throw new Error(
        `scheduleTileCodec: calendar[${ix}].days has length ${c.days?.length ?? "undefined"}, ` +
        `expected 7 ([mon, tue, wed, thu, fri, sat, sun])`,
      );
    }
    return {
      serviceId: c.serviceId,
      days: c.days as unknown as DaysOfWeek,
      startDate: c.startDate,
      endDate: c.endDate,
      added: c.added,
      removed: c.removed,
    };
  });

  return {
    bundleHash: validated.bundleHash,
    cityId: validated.cityId,
    tileSize: validated.tileSize,
    stringTable: validated.stringTable,
    routes: validated.routes,
    calendar,
    trips: validated.trips,
    stops,
  };
}
