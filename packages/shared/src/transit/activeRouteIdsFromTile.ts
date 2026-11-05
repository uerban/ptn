import { getDeparturesFromTile } from "./getDeparturesFromTile.js";
import type { DecodedScheduleTile } from "../types/scheduleTile.js";

export interface ActiveRouteIdsFromTileArgs {
  tile: DecodedScheduleTile;
  stopId: string;
  now: Date;
  lookAheadHours: number;
  /** City IANA tz; when set, the window is framed on the city's wall clock. */
  tz?: string;
}

// Far above any realistic in-window departure count, so getDeparturesFromTile's
// internal `.slice(0, limit)` can never drop a route: the busiest 2h window is
// well under 10k departures, and this cap sits ~100× beyond that for safety.
const UNBOUNDED_LIMIT = 1_000_000;

/**
 * The set of `route_id`s with at least one SCHEDULED departure at `stopId`
 * within `[now - grace, now + lookAheadHours]`, per the decoded schedule tile.
 *
 * This is the authoritative "which routes serve this stop soon" answer used by
 * the urban-mode badge filter. It is a thin wrapper over `getDeparturesFromTile`
 * (the live departure sheet's own engine) so the badge can never diverge from
 * the sheet. Real-time updates are intentionally NOT applied: a badge reflects
 * scheduled service (an RT-cancelled trip still shows its badge — permissive,
 * never restrictive), matching the prior index-based semantics.
 */
export function activeRouteIdsFromTile(args: ActiveRouteIdsFromTileArgs): Set<string> {
  const { departures } = getDeparturesFromTile({
    tile: args.tile,
    stopId: args.stopId,
    now: args.now,
    limit: UNBOUNDED_LIMIT,
    lookAheadHours: args.lookAheadHours,
    realtimeUpdates: undefined,
    tz: args.tz,
  });
  const ids = new Set<string>();
  for (const d of departures) ids.add(d.routeId);
  return ids;
}
