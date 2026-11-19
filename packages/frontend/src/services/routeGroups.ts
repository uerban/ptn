import type { TransportMode } from "@pt/shared";

/** An explicit operator-specific rule; colours and public line numbers are
 * presentation, not a global vehicle classification. GTFS route_type=3 can
 * legitimately cover both classes: https://gtfs.org/documentation/schedule/reference/#routestxt */
export interface RouteGroup {
  readonly id: string;
  readonly parentMode: TransportMode;
  readonly label: string;
  readonly labelKey?: string;
  readonly routeIdPattern?: string;
  readonly fallback?: boolean;
  /** GTFS `network_id` this group selects. */
  readonly networkId?: string;
  /** Stored selections that also address this group. */
  readonly aliases?: readonly string[];
  readonly defaultExcluded?: boolean;
}
/** Optional presentation for a GTFS network; the feed decides which networks exist.
 * https://gtfs.org/documentation/schedule/reference/#networkstxt */
export interface RouteNetworkConfig {
  readonly networkId: string;
  readonly id?: string;
  readonly label?: string;
  readonly labelKey?: string;
  readonly order?: number;
  readonly defaultExcluded?: boolean;
}
interface RouteIdentity { readonly id: string; readonly mode: TransportMode; readonly networkId?: string }
interface RouteNetworkIndex {
  readonly routes: readonly RouteIdentity[];
  readonly networks?: readonly { readonly id: string; readonly name?: string }[];
}
interface RouteGroupCity {
  readonly routeGroups?: readonly RouteGroup[];
  readonly routeNetworks?: readonly RouteNetworkConfig[];
}

const derivedGroups = new WeakMap<RouteNetworkIndex, WeakMap<RouteGroupCity, readonly RouteGroup[]>>();

function buildNetworkGroups(index: RouteNetworkIndex, city: RouteGroupCity): readonly RouteGroup[] {
  const byMode = new Map<TransportMode, { networks: Set<string>; unassigned: boolean }>();
  for (const route of index.routes) {
    const entry = byMode.get(route.mode) ?? { networks: new Set<string>(), unassigned: false };
    if (route.networkId) entry.networks.add(route.networkId);
    else entry.unassigned = true;
    byMode.set(route.mode, entry);
  }
  const chipModes = [...byMode].filter(([, e]) => e.networks.size > 0 && e.networks.size + (e.unassigned ? 1 : 0) >= 2);
  const modesOfNetwork = new Map<string, number>();
  for (const [, entry] of chipModes) {
    for (const id of entry.networks) modesOfNetwork.set(id, (modesOfNetwork.get(id) ?? 0) + 1);
  }
  const groups: RouteGroup[] = [];
  for (const [mode, entry] of chipModes) {
    const modeGroups = [...entry.networks].map((networkId) => {
      const config = city.routeNetworks?.find((row) => row.networkId === networkId);
      const baseId = config?.id;
      const id = baseId && modesOfNetwork.get(networkId) === 1 ? baseId : `${baseId ?? networkId}:${mode}`;
      const aliases = [...new Set([baseId, networkId])].filter((alias): alias is string => !!alias && alias !== id);
      const name = index.networks?.find((network) => network.id === networkId)?.name;
      return {
        order: config?.order ?? Number.POSITIVE_INFINITY,
        group: {
          id, parentMode: mode, networkId, aliases,
          label: config?.label ?? name ?? networkId,
          ...(config?.labelKey ? { labelKey: config.labelKey } : {}),
          ...(config?.defaultExcluded ? { defaultExcluded: true } : {}),
        } satisfies RouteGroup,
      };
    });
    modeGroups.sort((a, b) => a.order - b.order || a.group.label.localeCompare(b.group.label));
    groups.push(...modeGroups.map((row) => row.group));
    if (entry.unassigned) {
      const label = mode.charAt(0) + mode.slice(1).toLowerCase().replace(/_/g, " ");
      groups.push({ id: `other:${mode}`, parentMode: mode, label, labelKey: `settings.mode_${mode.toLowerCase()}`, fallback: true });
    }
  }
  return groups;
}

/** Filter groups for a loaded bundle. Feed networks win; `routeGroups` covers bundles without them. */
export function deriveRouteGroups(index: RouteNetworkIndex | null | undefined, city: RouteGroupCity): readonly RouteGroup[] {
  if (!index?.routes?.some((route) => route.networkId)) return city.routeGroups ?? [];
  let perCity = derivedGroups.get(index);
  if (!perCity) derivedGroups.set(index, perCity = new WeakMap());
  let groups = perCity.get(city);
  if (!groups) perCity.set(city, groups = buildNetworkGroups(index, city));
  return groups;
}

export function routeGroupFor(route: RouteIdentity, groups: readonly RouteGroup[]): RouteGroup | undefined {
  const candidates = groups.filter((g) => g.parentMode === route.mode);
  return candidates.find((g) => g.networkId !== undefined && g.networkId === route.networkId)
    ?? candidates.find((g) => g.routeIdPattern && new RegExp(g.routeIdPattern).test(route.id))
    ?? candidates.find((g) => g.fallback);
}
export function isRouteGroupExcluded(group: RouteGroup, excluded: readonly string[]): boolean {
  return excluded.includes(group.id) || (group.aliases ?? []).some((alias) => excluded.includes(alias));
}
/** Stored exclusions plus city defaults the rider has not explicitly enabled. */
export function effectiveExcludedRouteGroups(
  groups: readonly RouteGroup[], stored: readonly string[], enabled: readonly string[] = [],
): readonly string[] {
  const additions = groups.filter((g) => g.defaultExcluded && !enabled.includes(g.id) && !isRouteGroupExcluded(g, stored)).map((g) => g.id);
  return additions.length > 0 ? [...stored, ...additions] : stored;
}
export function excludedRouteIdsForGroups(routes: Iterable<RouteIdentity>, groups: readonly RouteGroup[], excluded: readonly string[]): string[] {
  if (groups.length === 0 || excluded.length === 0) return [];
  const ids: string[] = [];
  for (const route of routes) {
    const group = routeGroupFor(route, groups);
    if (group && isRouteGroupExcluded(group, excluded)) ids.push(route.id);
  }
  return [...new Set(ids)].sort();
}
/** Route IDs a rider has filtered out of planning in this city. */
export function excludedRouteIdsForCity(
  index: RouteNetworkIndex | null | undefined,
  city: RouteGroupCity & { readonly id: string },
  settings: { readonly excludedRouteGroupsByCity: Record<string, string[]>; readonly enabledRouteGroupsByCity?: Record<string, string[]> },
): string[] {
  if (!index) return [];
  const groups = deriveRouteGroups(index, city);
  const excluded = effectiveExcludedRouteGroups(groups, settings.excludedRouteGroupsByCity[city.id] ?? [], settings.enabledRouteGroupsByCity?.[city.id]);
  return excludedRouteIdsForGroups(index.routes, groups, excluded);
}
/** Remove a group's selection; a shared alias stays in force for its other variants. */
function withoutRouteGroup(excluded: readonly string[], group: RouteGroup, groups: readonly RouteGroup[]): string[] {
  const aliases = (group.aliases ?? []).filter((alias) => excluded.includes(alias));
  const variants = groups.filter((g) => g.id !== group.id && g.aliases?.some((alias) => aliases.includes(alias))).map((g) => g.id);
  return [...new Set([...excluded.filter((id) => id !== group.id && !aliases.includes(id)), ...variants])];
}
export function toggleRouteGroupSelection(
  excludedModes: readonly TransportMode[], excludedGroups: readonly string[], group: RouteGroup, groups: readonly RouteGroup[],
): { excludedModes: TransportMode[]; excludedGroups: string[] } {
  if (excludedModes.includes(group.parentMode)) {
    // A legacy parent-mode exclusion means all its children are off. Enabling
    // one child must leave its siblings off, preserving the user's selection.
    const siblings = groups.filter((g) => g.parentMode === group.parentMode && g.id !== group.id).map((g) => g.id);
    return { excludedModes: excludedModes.filter((m) => m !== group.parentMode), excludedGroups: [...new Set([...withoutRouteGroup(excludedGroups, group, groups), ...siblings])] };
  }
  return { excludedModes: [...excludedModes], excludedGroups: isRouteGroupExcluded(group, excludedGroups)
    ? withoutRouteGroup(excludedGroups, group, groups) : [...excludedGroups, group.id] };
}
