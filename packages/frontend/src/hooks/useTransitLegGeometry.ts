import { useEffect, useMemo, useReducer, useRef } from "react";
import { liveQuery } from "dexie";
import type { LatLon, LegGeometryResult, LegGeometrySource, RaptorTransitLeg } from "@pt/shared";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { reportError, reportTelemetry } from "../services/errorReporter.ts";
import { readLegSnapshot, type LegSnapshot } from "../services/legGeometry/readLegSnapshot.ts";
import { buildTransitGeometry } from "../services/legGeometry/buildTransitGeometry.ts";

const EMPTY: LegGeometryResult = {
  coords: [],
  source: "endpoints",
  partial: false,
  pending: true,
};

export function useTransitLegGeometry(
  leg: RaptorTransitLeg,
  fromLocation: LatLon,
  toLocation: LatLon,
): LegGeometryResult {
  const snapshotRef = useRef<LegSnapshot | null>(null);
  const lastSourceRef = useRef<LegGeometrySource | null>(null);
  const emittedTiersRef = useRef<Set<LegGeometrySource>>(new Set());
  const mountMsRef = useRef<number>(performance.now());
  const [, force] = useReducer((v: number) => v + 1, 0);

  useEffect(() => {
    const subscription = liveQuery(() => readLegSnapshot(leg)).subscribe({
      next: (value) => {
        snapshotRef.current = value;
        force();
      },
      error: (err) =>
        reportError(err as Error, {
          context: { where: "useTransitLegGeometry", leg },
        }),
    });
    return () => subscription.unsubscribe();
  }, [
    leg.tripId,
    leg.routeId,
    leg.boardStopIdx,
    leg.alightStopIdx,
    leg.patternStopIds?.join(","),
  ]);

  const syncing = useGtfsDataStore((s) => s.syncing);
  const snapshot = snapshotRef.current;
  const pending = snapshot === null || syncing;
  const tripShapeId = snapshot?.trip?.shapeId;
  const routeStopIdsLen = snapshot?.route?.stopIds.length ?? 0;
  const resolvedStopsLen = snapshot?.stops?.reduce(
    (acc, s) => acc + (s ? 1 : 0),
    0,
  ) ?? 0;
  const memoKey = `${leg.tripId}|${leg.routeId}|${tripShapeId ?? ""}|${leg.boardStopIdx}|${leg.alightStopIdx}|${leg.patternStopIds?.join(",") ?? ""}|${routeStopIdsLen}|${resolvedStopsLen}`;

  const result = useMemo<LegGeometryResult>(() => {
    if (!snapshot) return EMPTY;
    const base = buildTransitGeometry({
      kind: "leg",
      leg,
      route: snapshot.route,
      trip: snapshot.trip,
      shape: snapshot.shape,
      stops: snapshot.stops,
      fromLocation,
      toLocation,
    });
    return { ...base, pending };
  }, [memoKey, pending]);

  useEffect(() => {
    // Wait for real data before emitting — the initial `endpoints` + `pending`
    // snapshot is a placeholder, not a tier we want to measure.
    if (pending) return;

    // Fire `leg_geometry_source` only when the source actually changed for
    // this leg — dedupes across unrelated re-renders and StrictMode double-mounts.
    if (lastSourceRef.current !== result.source) {
      lastSourceRef.current = result.source;
      reportTelemetry("leg_geometry_source", {
        source: result.source,
        tripId: leg.tripId,
      });
    }

    // Fire `leg_geometry_time_to_tier_ms` on first reach of `shape` /
    // `intermediate` for this leg lifetime — feeds the rollout SLO
    // ("≥90% legs at `shape` within 3s").
    if (
      (result.source === "shape" || result.source === "intermediate") &&
      !emittedTiersRef.current.has(result.source)
    ) {
      emittedTiersRef.current.add(result.source);
      reportTelemetry("leg_geometry_time_to_tier_ms", {
        source: result.source,
        tripId: leg.tripId,
        ms: performance.now() - mountMsRef.current,
      });
    }
  }, [result.source, pending, leg.tripId]);

  return result;
}
