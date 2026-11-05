import type { StopGroupRecord } from "../db/index.ts";
import { haversineDistance } from "../utils/geo.ts";

export interface StopForGrouping {
  id: string;
  name: string;
  lat: number;
  lon: number;
  parentStation?: string;
}

export const STOP_PROXIMITY_THRESHOLD_M = 150;

// Regex for numbered suffix: "Name 01", "Name 02a", etc.
const NUMBERED_SUFFIX_RE = /^(.+?)\s+(\d{1,3}[a-z]?)$/i;

function avgLatLon(stops: StopForGrouping[]): { lat: number; lon: number } {
  const lat = stops.reduce((s, p) => s + p.lat, 0) / stops.length;
  const lon = stops.reduce((s, p) => s + p.lon, 0) / stops.length;
  return { lat, lon };
}

/**
 * Strategy 1: group stops that share the same parentStation field.
 * Returns grouped records and a set of stop IDs already accounted for.
 */
function groupByParentStation(
  stops: StopForGrouping[],
  grouped: Set<string>,
): StopGroupRecord[] {
  const byParent = new Map<string, StopForGrouping[]>();
  for (const stop of stops) {
    if (!stop.parentStation) continue;
    const arr = byParent.get(stop.parentStation) ?? [];
    arr.push(stop);
    byParent.set(stop.parentStation, arr);
  }

  const records: StopGroupRecord[] = [];
  for (const [parentId, members] of byParent) {
    if (members.length === 0) continue;
    const center = avgLatLon(members);
    records.push({
      groupId: `parent:${parentId}`,
      name: members[0].name,
      stopIds: members.map((s) => s.id),
      type: "parent_station",
      lat: center.lat,
      lon: center.lon,
    });
    for (const s of members) grouped.add(s.id);
  }
  return records;
}

/**
 * Strategy 2: group stops whose names match the numbered suffix pattern.
 * e.g. "Dworzec Glowny 01", "Dworzec Glowny 02", "Dworzec Glowny 01a"
 */
function groupByNumberedSuffix(
  stops: StopForGrouping[],
  grouped: Set<string>,
): StopGroupRecord[] {
  const byBase = new Map<string, StopForGrouping[]>();
  for (const stop of stops) {
    if (grouped.has(stop.id)) continue;
    const match = stop.name.match(NUMBERED_SUFFIX_RE);
    if (!match) continue;
    const base = match[1];
    const arr = byBase.get(base) ?? [];
    arr.push(stop);
    byBase.set(base, arr);
  }

  const records: StopGroupRecord[] = [];
  for (const [base, members] of byBase) {
    if (members.length < 2) continue; // single match → not a numbered group
    const center = avgLatLon(members);
    records.push({
      groupId: `numbered:${base}`,
      name: base,
      stopIds: members.map((s) => s.id),
      type: "name_numbered",
      lat: center.lat,
      lon: center.lon,
    });
    for (const s of members) grouped.add(s.id);
  }
  return records;
}

/**
 * Strategy 3: cluster remaining stops with the same name within
 * STOP_PROXIMITY_THRESHOLD_M using greedy nearest-neighbor.
 * Single ungrouped stops also become single-stop groups.
 */
function groupByNameCluster(
  stops: StopForGrouping[],
  grouped: Set<string>,
): StopGroupRecord[] {
  // Collect remaining stops (not yet grouped), keyed by name
  const byName = new Map<string, StopForGrouping[]>();
  for (const stop of stops) {
    if (grouped.has(stop.id)) continue;
    const arr = byName.get(stop.name) ?? [];
    arr.push(stop);
    byName.set(stop.name, arr);
  }

  const records: StopGroupRecord[] = [];

  for (const [name, candidates] of byName) {
    const visited = new Set<string>();

    for (const seed of candidates) {
      if (visited.has(seed.id)) continue;

      // Greedy: gather all same-name stops within threshold
      const cluster: StopForGrouping[] = [seed];
      visited.add(seed.id);

      for (const other of candidates) {
        if (visited.has(other.id)) continue;
        const dist = haversineDistance(seed, other);
        if (dist <= STOP_PROXIMITY_THRESHOLD_M) {
          cluster.push(other);
          visited.add(other.id);
        }
      }

      const center = avgLatLon(cluster);

      if (cluster.length === 1) {
        records.push({
          groupId: `single:${seed.id}`,
          name,
          stopIds: [seed.id],
          type: "name_cluster",
          lat: center.lat,
          lon: center.lon,
        });
      } else {
        records.push({
          groupId: `cluster:${name}:${center.lat.toFixed(4)}`,
          name,
          stopIds: cluster.map((s) => s.id),
          type: "name_cluster",
          lat: center.lat,
          lon: center.lon,
        });
      }

      for (const s of cluster) grouped.add(s.id);
    }
  }

  return records;
}

/**
 * Groups stops using three disambiguation strategies in priority order:
 * 1. parent_station — stops sharing the same GTFS parentStation
 * 2. name_numbered  — stops with numbered suffix ("Name 01", "Name 02a")
 * 3. name_cluster   — same-name stops clustered within 150 m proximity
 *
 * Stops consumed by an earlier strategy are excluded from later strategies.
 * Single remaining stops become single-stop "name_cluster" groups.
 */
export function groupStops(stops: StopForGrouping[]): StopGroupRecord[] {
  const grouped = new Set<string>();

  const parentGroups = groupByParentStation(stops, grouped);
  const numberedGroups = groupByNumberedSuffix(stops, grouped);
  const clusterGroups = groupByNameCluster(stops, grouped);

  return [...parentGroups, ...numberedGroups, ...clusterGroups];
}
