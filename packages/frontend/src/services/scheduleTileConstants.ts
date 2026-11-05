// Plain numeric constants for the schedule-tile read path. Deliberately has NO
// imports from Dexie/brotli/@pt/shared so it can be imported STATICALLY by
// useDepartures without pulling the heavy read-path graph into the eager Home
// chunk (the "barrel + greedy manualChunk" size leak), and so it resolves to a
// real value under the test mock that stubs scheduleTileReadPath.
export const DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD = 100; // departures.ts:75
export const DEFAULT_SCHEDULE_TILE_LIMIT = 20;                 // departures.ts:75
export const DEFAULT_SCHEDULE_TILE_LOOKAHEAD_HOURS = 1;        // store.ts:398

/**
 * Hedge budget for the COLD tile download+decode (NOT the always-present manifest/rt-tile RTT).
 * Build-time disablable via VITE_PT_DEPARTURES_HEDGE_MS: =0 disables the hedge (the consumer
 * guards on HEDGE_MS > 0); a very large value also effectively disables it (timer won't beat
 * the tile).
 */
const RAW = import.meta.env.VITE_PT_DEPARTURES_HEDGE_MS as string | undefined;
const PARSED = RAW != null ? Number(RAW) : NaN;
export const HEDGE_MS: number = Number.isFinite(PARSED) && PARSED >= 0 ? PARSED : 200;
