/**
 * leg-geometry telemetry aggregator.

 *
 * The frontend emits two telemetry events from
 * `packages/frontend/src/hooks/useTransitLegGeometry.ts`:
 *   - `leg_geometry_source` (counter, by source enum)
 *   - `leg_geometry_time_to_tier_ms` (histogram, by source enum)
 *
 * This module defines the in-process aggregation contract that any
 * future telemetry-ingest endpoint folds events into. Full ingest /
 * scrape implementation is an ops follow-up (see
 * the leg geometry dashboard notes —
 * "Provisioning checklist"); this file ships the typed shapes + a
 * minimal in-memory implementation so the contract is exercised by
 * unit tests today.
 *
 * Histogram bucket boundaries are chosen to match the dashboard
 * panel SLOs (3000 ms p95, 15000 ms p99 ceiling): tighter buckets
 * around the SLO thresholds, coarser buckets out at the tail.
 */

import type { LegGeometrySource } from "@pt/shared";

/** Inbound telemetry event after frontend → backend hop. */
export interface LegGeometrySourceEvent {
  event: "leg_geometry_source";
  data: {
    source: LegGeometrySource;
    tripId: string;
  };
  /** epoch ms; injected by the frontend */
  ts: number;
}

export interface LegGeometryTimeToTierEvent {
  event: "leg_geometry_time_to_tier_ms";
  data: {
    /** Only `shape` and `intermediate` carry a latency — see the hook. */
    source: Extract<LegGeometrySource, "shape" | "intermediate">;
    tripId: string;
    ms: number;
  };
  ts: number;
}

export type LegGeometryEvent =
  | LegGeometrySourceEvent
  | LegGeometryTimeToTierEvent;

/**
 * Histogram bucket upper bounds (ms) — Prometheus / OpenMetrics-style
 * cumulative histogram. Tuned for the leg-geometry SLOs:
 *   - tight buckets through the 3 s p95 budget
 *   - mid-resolution out to the 15 s p99 ceiling
 *   - one coarse +Inf-equivalent bucket for the unbounded tail
 * Keep monotonic-increasing; consumers rely on the boundary order to
 * compute quantiles.
 */
export const TIME_TO_TIER_BUCKETS_MS: readonly number[] = [
  100,
  250,
  500,
  1_000,
  1_500,
  2_000,
  3_000,
  5_000,
  10_000,
  15_000,
  Number.POSITIVE_INFINITY,
] as const;

/**
 * Per-source rollup of the source counter + the time-to-tier histogram.
 * Cumulative buckets — bucket[i] is the count of samples ≤ bucket[i].
 */
export interface SourceAggregate {
  /** Total observations of this source via `leg_geometry_source`. */
  count: number;
  /** Histogram bucket counts for `leg_geometry_time_to_tier_ms`.
   *  `null` for sources that never emit a latency (`endpoints`,
   *  `osrm-foot`).  `cumulative[i]` is samples with `ms ≤ TIME_TO_TIER_BUCKETS_MS[i]`. */
  cumulative: number[] | null;
  /** Sum of all observed `ms` values; required to compute mean. */
  sumMs: number | null;
  /** Number of latency observations (denominator for sumMs). */
  observations: number | null;
}

export type LegGeometryAggregateSnapshot = Record<
  LegGeometrySource,
  SourceAggregate
>;

/** Sources that emit a latency observation. Keep in sync with the hook. */
const LATENCY_SOURCES: ReadonlySet<LegGeometrySource> = new Set([
  "shape",
  "intermediate",
]);

const ALL_SOURCES: readonly LegGeometrySource[] = [
  "shape",
  "intermediate",
  "endpoints",
  "osrm-foot",
  "walk-graph",
] as const;

function emptyAggregate(source: LegGeometrySource): SourceAggregate {
  const carriesLatency = LATENCY_SOURCES.has(source);
  return {
    count: 0,
    cumulative: carriesLatency ? new Array(TIME_TO_TIER_BUCKETS_MS.length).fill(0) : null,
    sumMs: carriesLatency ? 0 : null,
    observations: carriesLatency ? 0 : null,
  };
}

function emptySnapshot(): LegGeometryAggregateSnapshot {
  // Build with a fresh aggregate per source rather than spreading a
  // template, so each source's `cumulative` array is its own buffer.
  return {
    shape: emptyAggregate("shape"),
    intermediate: emptyAggregate("intermediate"),
    endpoints: emptyAggregate("endpoints"),
    "osrm-foot": emptyAggregate("osrm-foot"),
    "walk-graph": emptyAggregate("walk-graph"),
  };
}

/**
 * In-memory aggregator. The full ingest pipeline (HTTP endpoint +
 * Prometheus exposition) is the ops follow-up; this class is the seam
 * those handlers slot into. Keeping the implementation in-memory is
 * fine for the canary scale (≤ a few hundred legs/min per backend);
 * if scale grows past that, swap for a Prometheus client lib without
 * changing the consumer surface.
 */
export class LegGeometryAggregator {
  private snapshot: LegGeometryAggregateSnapshot = emptySnapshot();

  ingest(event: LegGeometryEvent): void {
    if (event.event === "leg_geometry_source") {
      const agg = this.snapshot[event.data.source];
      if (!agg) return; // unknown enum value — drop silently
      agg.count += 1;
      return;
    }
    if (event.event === "leg_geometry_time_to_tier_ms") {
      const agg = this.snapshot[event.data.source];
      if (!agg || agg.cumulative === null) return;
      const ms = event.data.ms;
      if (!Number.isFinite(ms) || ms < 0) return;
      // Cumulative bucket: increment every bucket whose upper bound is
      // ≥ the observation. The +Inf-equivalent boundary at the tail is
      // always crossed.
      for (let i = 0; i < TIME_TO_TIER_BUCKETS_MS.length; i++) {
        if (ms <= TIME_TO_TIER_BUCKETS_MS[i]) {
          agg.cumulative[i] += 1;
        }
      }
      agg.sumMs = (agg.sumMs ?? 0) + ms;
      agg.observations = (agg.observations ?? 0) + 1;
      return;
    }
  }

  /** Defensive copy — callers must not mutate a returned snapshot. */
  read(): LegGeometryAggregateSnapshot {
    const out = emptySnapshot();
    for (const src of ALL_SOURCES) {
      const a = this.snapshot[src];
      out[src] = {
        count: a.count,
        cumulative: a.cumulative === null ? null : a.cumulative.slice(),
        sumMs: a.sumMs,
        observations: a.observations,
      };
    }
    return out;
  }

  reset(): void {
    this.snapshot = emptySnapshot();
  }
}
