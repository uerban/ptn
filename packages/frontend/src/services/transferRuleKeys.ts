/**
 * Stop-pair key for `RaptorIndex.transferRules`. A `\t` separator is safe:
 * GTFS stop_ids cannot contain a tab. KEY BY STRING PAIR (not a dense int
 * key) — both engines use this exact formula, avoiding the stop-index-space
 * mismatch documented in the S1 design spec.
 */
export function transferRuleKey(fromStopId: string, toStopId: string): string {
  return `${fromStopId}\t${toStopId}`;
}

/**
 * Trip-scoped key for `RaptorIndex.transferRulesTripScoped` (S3). A GTFS
 * `transfers.txt` row carrying BOTH `from_trip_id` AND `to_trip_id` is the
 * MOST-SPECIFIC rule for a board: it applies only when continuing from
 * `fromTripId` onto `toTripId` at the `(fromStopId,toStopId)` pair. The `\t`
 * separator is safe (GTFS trip_ids/stop_ids cannot contain a tab). Both engines
 * use this EXACT formula so the scan looks up the same key — the index-space
 * hazard from S1 is sidestepped by keying on STRING ids on both sides.
 */
export function transferTripScopedKey(
  fromStopId: string,
  toStopId: string,
  fromTripId: string,
  toTripId: string,
): string {
  return `${fromStopId}\t${toStopId}\t${fromTripId}\t${toTripId}`;
}

/**
 * Route-scoped key for `RaptorIndex.transferRulesRouteScoped` (S3). A
 * `transfers.txt` row carrying BOTH `from_route_id` AND `to_route_id` (and no
 * trip scope) applies when continuing from any trip on `fromRouteId` onto any
 * trip on `toRouteId` at the stop pair — LESS specific than trip→trip, MORE
 * specific than the unscoped stop→stop rule. Same string-key discipline.
 */
export function transferRouteScopedKey(
  fromStopId: string,
  toStopId: string,
  fromRouteId: string,
  toRouteId: string,
): string {
  return `${fromStopId}\t${toStopId}\t${fromRouteId}\t${toRouteId}`;
}

