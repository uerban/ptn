/**
 * InternTable<T> — read-side contract for identity intern tables.
 *
 * Builders (in @pt/backend/gtfs/identity) produce concrete implementations
 * at GTFS load time. Consumers elsewhere in the backend (and eventually the
 * frontend, for the shippable routing bundle) only need the read side.
 */
export interface InternTable<T> {
  /** Total number of distinct entries. */
  readonly size: number;
  /** Look up the ix for a previously-interned value. Returns -1 if unknown. */
  indexOf(value: T): number;
  /** Retrieve the original value for a given ix. Throws on out-of-range. */
  valueAt(ix: number): T;
}

/**
 * ServiceBitmask — per-service active-day bitmap over a rolling horizon.
 *
 * `bits` is a Uint8Array of length `ceil(horizonDays/8)`. Day `d` (0-indexed
 * from `startDateIso`) is active if `(bits[d>>3] >> (d & 7)) & 1`.
 *
 * Built by `ServiceBitmaskBuilder` from `calendar.txt` + `calendar_dates.txt`.
 * Always resident in memory (small — at 100k services × 90 days / 8 ≈ 1.1 MB).
 */
export interface ServiceBitmask {
  /** ISO date YYYY-MM-DD for day 0 of the bitmap. */
  readonly startDateIso: string;
  /** Number of days covered by this bitmap (spec default 90). */
  readonly horizonDays: number;
  /** Packed active-day bits. Length = ceil(horizonDays / 8). */
  readonly bits: Uint8Array;
}

/**
 * Helper: is day `d` (0-indexed from bitmap start) active?
 */
export function isDayActive(mask: ServiceBitmask, d: number): boolean {
  if (d < 0 || d >= mask.horizonDays) return false;
  return ((mask.bits[d >> 3] ?? 0) >> (d & 7) & 1) === 1;
}
