import protobuf from "protobufjs/light.js";

// ── Schema ──────────────────────────────────────────────────────────────────

const root = new protobuf.Root();

const TripUpdate = new protobuf.Type("TripUpdate")
  .add(new protobuf.Field("tripId", 1, "string"))
  .add(new protobuf.Field("delaySeconds", 2, "sint32"))
  .add(new protobuf.Field("cancelled", 3, "bool"))
  // pt-serve emits it only when true; absent means "not deleted".
  .add(new protobuf.Field("deleted", 4, "bool"));

const RouteUpdate = new protobuf.Type("RouteUpdate")
  .add(TripUpdate)
  .add(new protobuf.Field("routeId", 1, "string"))
  .add(new protobuf.Field("trips", 2, "TripUpdate", "repeated"))
  .add(new protobuf.Field("generatedAt", 3, "int64"));

root.add(RouteUpdate);

// ── TypeScript interfaces (source of truth for consumers) ───────────────────

/** Real-time update for a single trip within a route */
export interface RtTripUpdate {
  tripId: string;
  delaySeconds: number;
  cancelled: boolean;
  /**
   * The trip is removed — GTFS-RT `DELETED`, which "must not be shown to
   * users … so the trip is not shown as cancelled to riders", e.g. replaced
   * by substitute service. Never offered, never listed; not `cancelled`.
   * Protobuf field 4, sent only when true: absent reads as not deleted.
   */
  deleted?: boolean;
  /**
   * GTFS-RT `trip.start_date` (YYYYMMDD), when the feed sets it. Added to the
   * TS interface ONLY — NOT the protobuf `TripUpdate` schema above (fields
   * 1-3). protobufjs ignores undeclared object fields (exactly like
   * `receivedAt`), so the binary `RouteUpdate`/`/rt` wire is unaffected; the
   * rt-tile JSON route carries it so a client can rebuild the backend
   * snapshot's date-scoped (`${tripId}|${startDate}`) keys. Do NOT add a
   * protobuf field for this — it would silently change the binary wire.
   */
  startDate?: string;
  /**
   * Wall-clock millisecond timestamp set when the update is stored in
   * `rtStore`. Used by the 120s freshness guard in `rtOverlay`. Not
   * present in the wire protobuf (the decoder leaves it undefined and
   * each `rtStore` writer populates it on insertion). Optional for
   * backwards-compat: missing `receivedAt` is treated as fresh, so
   * pre-existing seeded data and any forgotten writer site doesn't
   * silently drop RT corrections.
   */
  receivedAt?: number;
}

/** Real-time update for all trips on a route */
export interface RtRouteUpdate {
  routeId: string;
  trips: RtTripUpdate[];
  /** Unix timestamp (ms) when this update was generated */
  generatedAt: number;
}

// ── Encode / Decode ─────────────────────────────────────────────────────────

/** Encode a route update to a protobuf binary buffer */
export function encodeRouteUpdate(update: RtRouteUpdate): Uint8Array {
  const err = RouteUpdate.verify(update);
  if (err) throw new Error(`RouteUpdate verification failed: ${err}`);
  return RouteUpdate.encode(RouteUpdate.create(update)).finish();
}

/** Decode a protobuf binary buffer into a route update */
export function decodeRouteUpdate(buffer: Uint8Array): RtRouteUpdate {
  const msg = RouteUpdate.decode(buffer);
  // `arrays: true` keeps `trips: []` when no updates are present. Without it
  // protobufjs omits the field, violating the RtRouteUpdate contract and
  // crashing consumers that iterate without a null check.
  const obj = RouteUpdate.toObject(msg, { longs: Number, arrays: true }) as RtRouteUpdate;
  return obj;
}
