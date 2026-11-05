/**
 * Tracker for stop_times referential integrity.
 *
 * Every stop_times row either references a known tripId (recorded via
 * recordKnown) or a tripId absent from trips.txt (recorded via recordOrphan).
 * The feed is rejected when the orphan ratio exceeds `threshold` — prevents
 * a mildly hostile mirror from DoSing us via a single bad row per refresh
 * (the row is cheap) while still dropping small amounts of orphan data
 * gracefully.
 */

export interface OrphanTracker {
  readonly total: number;
  readonly orphan: number;
  /** Fraction of recorded rows that were orphan. 0 when total === 0. */
  ratio(): number;
  recordKnown(): void;
  recordOrphan(): void;
  /** Throw with a descriptive message if the current ratio exceeds threshold. */
  assertWithinThreshold(): void;
}

export interface OrphanTrackerOptions {
  /** Maximum acceptable orphan ratio before rejection. Spec default 0.001 (0.1%). */
  threshold: number;
}

export function createOrphanTracker(opts: OrphanTrackerOptions): OrphanTracker {
  let total = 0;
  let orphan = 0;
  return {
    get total() { return total; },
    get orphan() { return orphan; },
    ratio(): number {
      return total === 0 ? 0 : orphan / total;
    },
    recordKnown(): void {
      total++;
    },
    recordOrphan(): void {
      total++;
      orphan++;
    },
    assertWithinThreshold(): void {
      const r = total === 0 ? 0 : orphan / total;
      if (r > opts.threshold) {
        throw new Error(
          `GTFS feed rejected — stop_times referential integrity check failed: ` +
          `${orphan}/${total} rows (${(r * 100).toFixed(3)}%) reference unknown trip_ids ` +
          `(threshold ${(opts.threshold * 100).toFixed(3)}%)`,
        );
      }
    },
  };
}
