import type { InternTable, ServiceBitmask } from "@pt/shared";

/**
 * Identity — always-resident per-city lookup tables + service bitmasks.
 * Built at GTFS load time; re-built on every refresh.*/
export interface Identity {
  /** stop_id → StopIx; valueAt(ix) → stop_id. Size = number of distinct stops. */
  readonly stops: InternTable<string>;
  /** route_id → RouteIx; valueAt(ix) → route_id. Size = number of distinct routes. */
  readonly routes: InternTable<string>;
  /** service_id → ServiceIx. */
  readonly services: InternTable<string>;
  /** headsign → HeadsignIx. Distinct trip_headsign strings. */
  readonly headsigns: InternTable<string>;
  /** trip_id → TripIx. */
  readonly trips: InternTable<string>;
  /** service_id → 90-day active-day bitmap, anchored at buildDateIso. */
  readonly bitmasks: ReadonlyMap<string, ServiceBitmask>;
  /** ISO date (YYYY-MM-DD) that Identity was built relative to. */
  readonly buildDateIso: string;
  /** Horizon (days) covered by bitmasks. */
  readonly horizonDays: number;
}
