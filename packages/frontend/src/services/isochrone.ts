import {
  type LatLon,
  type MobilityProfile,
} from "@pt/shared";
import { OSRM_FOOT_SPEED_MPS } from "@pt/shared/constants";
import { riderWalkSpeedMps, runSpeedMps } from "@pt/shared/routing";
import {
  findStopsInRadius,
  type OsmTransferLookup,
  type ReachableStop,
} from "./stopFinder.ts";
import type { OsrmWasmClient } from "./osrmWasm.ts";

interface StopLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

interface IsochroneOptions {
  maxWalkSecs: number;
  walkSpeedMps: number;
  radiusMeters: number;
  /**
   * Enable "run to catch": cover the same time budget at a hurried pace, so a
   * stop the user cannot *walk* to inside `maxWalkSecs` still qualifies when
   * they can *run* to it inside the very same budget. Such stops are returned
   * with their running time in `walkSecs` and flagged `runToCatch: true`.
   */
  runToCatch?: boolean;
  /**
   * Pre-computed pedestrian transfer table. Only consulted on the
   * haversine fallback path (OSRM-WASM, when ready, already gives a
   * better walk-time than the table can). Requires `originStopId` or
   * `destStopId` to be set on the same options.
   */
  osmLookup?: OsmTransferLookup;
  /**
   * Stop id the origin coordinate resolves to (set by callers when the
   * endpoint is a `stop`-kind endpoint). Used as the from-side of the
   * pre-computed transfer-table lookup (entry walk); ignored when
   * `osmLookup` is absent.
   */
  originStopId?: string;
  /**
   * Stop id the destination coordinate resolves to. Used as the to-side
   * of the transfer-table lookup (exit walk: `candidate → destStopId`).
   * Mutually exclusive with `originStopId`.
   */
  destStopId?: string;
  /**
   * Opaque stop ids to force into the result at walkSecs:0 (entry-walk side),
   * e.g. all siblings of a tapped stop group. NOTE the plural: unlike
   * `originStopId` (singular — transfer-table walk-time ACCURACY), these
   * OVERRIDE the computed walk-time to 0 regardless of distance. A forced id
   * not present in `stops` is appended as-is (`{walkSecs:0}`) and relies on the
   * downstream routing index to ignore unknown ids — no membership check happens
   * here (the seam treats them as opaque).
   */
  originStopIds?: string[];
  /** Same as `originStopIds`, for the exit-walk side. */
  destStopIds?: string[];
  /**
   * Which side of the journey the `origin` argument represents. "origin"
   * (default) treats `origin` as the user's start — both the OSRM-WASM
   * table query and the haversine lookup read in the entry-walk direction
   * (`origin → candidate`). "destination" treats `origin` as the user's
   * end — the OSRM-WASM query is flipped to `candidate → origin` so an
   * asymmetric foot profile yields the correct exit-walk durations
   * (Dijkstra-built tables are symmetric, OSRM-built ones aren't
   * guaranteed to be).
   */
  role?: "origin" | "destination";
}

/**
 * Find stops reachable from a point within the walking time budget.
 *
 * Strategy:
 * 1. If OSRM WASM is available, use table query for accurate walking times
 * 2. Otherwise, fall back to straight-line radius-based filtering
 * 3. If runToCatch is enabled, do a second pass at running speed over the
 *    SAME maxWalkSecs budget — the time cap the user set is never widened,
 *    the pace inside it changes — and flag the stops it adds with
 *    runToCatch: true, carrying their running time as walkSecs
 *
 * The OSRM approach excludes stops across rivers/highways without walkable
 * paths, which straight-line distance cannot detect.
 *
 * `mobilityProfile: "wheelchair"` overrides `options.walkSpeedMps` with
 * `WHEELCHAIR_WALK_SPEED_MPS` and force-disables run-to-catch.
 */
export async function findReachableStops(
  origin: LatLon,
  stops: StopLocation[],
  options: IsochroneOptions,
  osrm: Pick<OsrmWasmClient, "isReady" | "table">,
  mobilityProfile: MobilityProfile = "default",
): Promise<ReachableStop[]> {
  const { maxWalkSecs, walkSpeedMps, radiusMeters } = options;
  const runToCatchEnabled = options.runToCatch ?? false;

  const isWheelchair = mobilityProfile === "wheelchair";
  const effectiveWalkSpeed = riderWalkSpeedMps(mobilityProfile, walkSpeedMps);
  // Wheelchair users can't run — force-disable run-to-catch regardless of user toggle.
  const runToCatchActive = runToCatchEnabled && !isWheelchair;
  // Run-to-catch buys speed, never budget: `maxWalkSecs` still bounds every
  // stop returned here. An earlier revision instead handed out a flat 120 s of
  // extra budget, which let a stop in at its full *walking* time — so the
  // rider was told to set off two minutes late for a departure they could
  // only have made by running. Nothing downstream ever shortened that leg.
  const runSpeed = runSpeedMps(effectiveWalkSpeed);

  // Stop-group force-in: a tapped same-name stop group must route from ALL its
  // member stops at walkSecs:0, even when a member falls outside the walk
  // radius / OSRM budget. The member ids are opaque strings (seam invariant);
  // the entry-walk side reads originStopIds, the exit-walk side destStopIds.
  const forceIds = (options.role ?? "origin") === "destination"
    ? options.destStopIds
    : options.originStopIds;
  const applyForced = (rows: ReachableStop[]): ReachableStop[] => {
    if (!forceIds || forceIds.length === 0) return rows;
    const byId = new Map(rows.map((r) => [r.stopId, r]));
    for (const id of forceIds) {
      const existing = byId.get(id);
      if (existing) {
        existing.walkSecs = 0;
        existing.distanceMeters = 0;
      } else {
        const r: ReachableStop = { stopId: id, walkSecs: 0, distanceMeters: 0 };
        rows.push(r);
        byId.set(id, r);
      }
    }
    rows.sort((a, b) => a.walkSecs - b.walkSecs);
    return rows;
  };

  if (osrm.isReady()) {
    const role = options.role ?? "origin";
    const stopLocs = stops.map((s) => ({ lat: s.lat, lon: s.lon }));
    // Exit walk wants `candidate stop → origin` (origin is the user's
    // destination here); flip the OSRM sources/destinations so an
    // asymmetric foot profile reports the right direction. For symmetric
    // engines the two queries are equivalent.
    const tableResult = role === "destination"
      ? await osrm.table(stopLocs, [origin])
      : await osrm.table([origin], stopLocs);

    if (tableResult && tableResult.durations.length > 0) {
      const durations = role === "destination"
        ? tableResult.durations.map((row) => row[0])
        : tableResult.durations[0];
      const results: ReachableStop[] = [];

      for (let i = 0; i < stops.length; i++) {
        const osrmSecs = Math.round(durations[i]);
        if (osrmSecs < 0) continue;
        // OSRM returns durations from its 5 km/h foot profile. Convert back to
        // physical distance, then rescale to the caller's effective speed so
        // slower-walking profiles (wheelchair) get realistic walkSecs budgets.
        const distanceMeters = Math.round(osrmSecs * OSRM_FOOT_SPEED_MPS);
        const walkSecs = Math.round(distanceMeters / effectiveWalkSpeed);

        if (walkSecs <= maxWalkSecs) {
          results.push({ stopId: stops[i].id, walkSecs, distanceMeters });
          continue;
        }
        if (!runToCatchActive) continue;
        // Same budget, faster pace. `walkSecs` carries the running time so the
        // plan's departure math reflects the trip the rider is actually asked
        // to make.
        const runSecs = Math.round(distanceMeters / runSpeed);
        if (runSecs <= maxWalkSecs) {
          results.push({
            stopId: stops[i].id,
            walkSecs: runSecs,
            distanceMeters,
            runToCatch: true,
          });
        }
      }

      results.sort((a, b) => a.walkSecs - b.walkSecs);
      return applyForced(results);
    }
  }

  const findOpts = {
    originStopId: options.originStopId,
    destStopId: options.destStopId,
    osmLookup: options.osmLookup,
  };
  const baseResults = findStopsInRadius(origin, stops, radiusMeters, effectiveWalkSpeed, findOpts);

  if (runToCatchActive) {
    // The radius is a distance proxy for the same time budget: what the rider
    // covers in `radiusMeters` at walking speed, they cover in
    // `radiusMeters * runSpeed / walkSpeed` at a run. Passing runSpeed to
    // findStopsInRadius also makes the extra stops carry running times.
    const runRadiusMeters = Math.round(
      (radiusMeters * runSpeed) / effectiveWalkSpeed,
    );
    const runResults = findStopsInRadius(origin, stops, runRadiusMeters, runSpeed, findOpts);
    const baseIds = new Set(baseResults.map((r) => r.stopId));

    for (const stop of runResults) {
      if (!baseIds.has(stop.stopId)) {
        baseResults.push({ ...stop, runToCatch: true });
      }
    }
    baseResults.sort((a, b) => a.walkSecs - b.walkSecs);
  }

  // Force-in applied at the FINAL return so it survives the runToCatch
  // second pass above.
  return applyForced(baseResults);
}
