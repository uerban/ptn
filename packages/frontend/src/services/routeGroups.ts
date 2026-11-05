import type { TransportMode } from "@pt/shared";

/** An explicit operator-specific rule; colours and public line numbers are
 * presentation, not a global vehicle classification. GTFS route_type=3 can
 * legitimately cover both classes: https://gtfs.org/documentation/schedule/reference/#routestxt */
export interface RouteGroup {
  readonly id: string;
  readonly parentMode: TransportMode;
  readonly label: string;
  readonly labelKey: string;
  readonly routeIdPattern?: string;
  readonly fallback?: boolean;
}
interface RouteIdentity { readonly id: string; readonly mode: TransportMode }
export function routeGroupFor(route: RouteIdentity, groups: readonly RouteGroup[]): RouteGroup | undefined {
  const candidates = groups.filter((g) => g.parentMode === route.mode);
  return candidates.find((g) => g.routeIdPattern && new RegExp(g.routeIdPattern).test(route.id))
    ?? candidates.find((g) => g.fallback);
}
export function excludedRouteIdsForGroups(routes: Iterable<RouteIdentity>, groups: readonly RouteGroup[], excluded: readonly string[]): string[] {
  if (groups.length === 0 || excluded.length === 0) return [];
  const ids: string[] = [];
  for (const route of routes) {
    const group = routeGroupFor(route, groups);
    if (group && excluded.includes(group.id)) ids.push(route.id);
  }
  return [...new Set(ids)].sort();
}
export function toggleRouteGroupSelection(
  excludedModes: readonly TransportMode[], excludedGroups: readonly string[], group: RouteGroup, groups: readonly RouteGroup[],
): { excludedModes: TransportMode[]; excludedGroups: string[] } {
  if (excludedModes.includes(group.parentMode)) {
    // A legacy parent-mode exclusion means all its children are off. Enabling
    // one child must leave its siblings off, preserving the user's selection.
    const siblings = groups.filter((g) => g.parentMode === group.parentMode && g.id !== group.id).map((g) => g.id);
    return { excludedModes: excludedModes.filter((m) => m !== group.parentMode), excludedGroups: [...new Set([...excludedGroups.filter((id) => id !== group.id), ...siblings])] };
  }
  return { excludedModes: [...excludedModes], excludedGroups: excludedGroups.includes(group.id)
    ? excludedGroups.filter((id) => id !== group.id) : [...excludedGroups, group.id] };
}
