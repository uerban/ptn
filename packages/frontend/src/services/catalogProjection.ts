import type {RoutingBundleRoute, TransportMode} from "@pt/shared";

/**
 * Aggregate per-pattern wire routes to one display record per route_id.
 * Under Unbounded mode the wire carries repeated route_ids (one per pattern);
 * `db.gtfsRoutes` has PK=id so we must de-duplicate before `bulkPut`.
 * Strategy: longest-pattern stopIds wins; directionPatterns are unioned.
 * The full per-pattern records live only in the `gtfsBundle` blob.
 */
export function aggregateDisplayRoutes(routes: readonly RoutingBundleRoute[]): {
  id: string;
  shortName: string;
  mode: TransportMode;
  color?: string;
  textColor?: string;
  stopIds: string[];
  directionPatterns?: { key: string; headsign: string; stopIds: string[] }[];
}[] {
  const byId = new Map<string, {
    id: string; shortName: string; mode: TransportMode;
    color?: string; textColor?: string;
    stopIds: string[];
    directionPatterns?: { key: string; headsign: string; stopIds: string[] }[];
  }>();
  const order: string[] = [];

  for (const r of routes) {
    const existing = byId.get(r.id);
    if (!existing) {
      byId.set(r.id, {
        id: r.id, shortName: r.shortName, mode: r.mode,
        color: r.color, textColor: r.textColor,
        stopIds: [...r.stopIds],
        ...(r.directionPatterns && r.directionPatterns.length > 0
          ? { directionPatterns: r.directionPatterns.map((p) => ({ key: p.key, headsign: p.headsign, stopIds: [...p.stopIds] })) }
          : {}),
      });
      order.push(r.id);
      continue;
    }
    // Longest stopIds sequence is the canonical display sequence.
    if (r.stopIds.length > existing.stopIds.length) existing.stopIds = [...r.stopIds];
    // Union directionPatterns, then dedup by (direction key, headsign).
    // Branch variants may share direction_id while displaying distinct
    // headsigns, so key-only dedup would discard a valid pattern.
    if (r.directionPatterns && r.directionPatterns.length > 0) {
      const merged = [
        ...(existing.directionPatterns ?? []),
        ...r.directionPatterns.map((p) => ({ key: p.key, headsign: p.headsign, stopIds: [...p.stopIds] })),
      ];
      existing.directionPatterns = merged.filter(
        (p, i, arr) => arr.findIndex(
          (x) => x.key === p.key && x.headsign === p.headsign,
        ) === i,
      );
    }
  }

  return order.map((id) => byId.get(id)!);
}
