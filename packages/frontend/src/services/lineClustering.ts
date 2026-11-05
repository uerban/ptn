import type { RaptorIndexRoute } from "./raptorIndex.ts";
import { findStopIdxInRoute } from "./util/directionPatternIdx.ts";

export interface LineCluster {
  routeIds: string[];
  labels: string[]; // Route short names
  sharedStopIds: string[];
  direction: string; // Terminal stop ID as direction hint
}

/**
 * Compute the shared prefix between two arrays of stop IDs.
 */
function sharedPrefix(a: string[], b: string[]): string[] {
  const result: string[] = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) {
      result.push(a[i]);
    } else {
      break;
    }
  }
  return result;
}

/**
 * Find clusters of routes that share consecutive stops from a given stop
 * in the forward direction.
 *
 * NOTE: The RAPTOR index stores one `stopIds` array per route, not per
 * direction. Using `stopIds.slice(fromStopIdx)` gives only the forward
 * direction from the given stop. True bidirectional detection would require
 * per-trip stop sequences (which vary by direction). This is a known
 * simplification.
 *
 * @param fromStopId     The stop ID to start clustering from.
 * @param routes         All routes from the RAPTOR index.
 * @param minSharedStops Minimum number of consecutive shared stops required
 *                       to place two routes in the same cluster.
 */
export function findLineClusters(
  fromStopId: string,
  routes: RaptorIndexRoute[],
  minSharedStops: number,
): LineCluster[] {
  // Build subsequences for routes that serve fromStopId.
  interface RouteSubseq {
    route: RaptorIndexRoute;
    subseq: string[]; // stopIds from fromStopId onward (inclusive)
  }

  const serving: RouteSubseq[] = [];
  for (const route of routes) {
    const { idx, pattern } = findStopIdxInRoute(route, fromStopId);
    if (idx === -1) continue;
    const seq = pattern ? pattern.stopIds : route.stopIds;
    serving.push({ route, subseq: seq.slice(idx) });
  }

  if (serving.length === 0) return [];

  // Union-Find helpers for clustering.
  const parent: number[] = serving.map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(x: number, y: number): void {
    parent[find(x)] = find(y);
  }

  // Track the best shared prefix between pairs so we can reconstruct it.
  // Key: "rootA-rootB" (after union), value: shared prefix.
  // We store per-pair prefix and later pick the minimum within a cluster.
  const pairPrefix = new Map<string, string[]>();

  for (let i = 0; i < serving.length; i++) {
    for (let j = i + 1; j < serving.length; j++) {
      const prefix = sharedPrefix(serving[i].subseq, serving[j].subseq);
      if (prefix.length >= minSharedStops) {
        union(i, j);
        const key = `${i}-${j}`;
        pairPrefix.set(key, prefix);
      }
    }
  }

  // Group routes by cluster root.
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < serving.length; i++) {
    const root = find(i);
    let members = clusterMap.get(root);
    if (!members) {
      members = [];
      clusterMap.set(root, members);
    }
    members.push(i);
  }

  // Build LineCluster objects.
  const clusters: LineCluster[] = [];

  for (const [, members] of clusterMap) {
    if (members.length < 2) {
      // A single route with no partner meeting the threshold — skip.
      continue;
    }

    // Compute the shared prefix across all members in the cluster by
    // intersecting subsequences pairwise (take the minimum common prefix).
    let sharedStopIds = serving[members[0]].subseq;
    for (let k = 1; k < members.length; k++) {
      sharedStopIds = sharedPrefix(sharedStopIds, serving[members[k]].subseq);
    }

    // Use the last stop of the shared prefix as direction hint.
    const direction = sharedStopIds[sharedStopIds.length - 1] ?? fromStopId;

    clusters.push({
      routeIds: members.map((i) => serving[i].route.id),
      labels: members.map((i) => serving[i].route.shortName),
      sharedStopIds,
      direction,
    });
  }

  return clusters;
}
