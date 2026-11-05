/**
 * Performance marks of the opt-in Arrive-by UI, read by the desktop and phone
 * checks (`performance.getEntriesByType("mark")`). A mark never affects the UI.
 */
export const ARRIVE_BY_MARKS = {
  /** The rider chose Arrive by. */
  choose: "ptn:arrive-by:choose",
  /** A warm-up settled; detail `{ result, trigger }`, trigger `results`
   * (H75, Leave now) or `choice` (H72). */
  warm: "ptn:arrive-by:warm",
  /** The rider applied a deadline. */
  apply: "ptn:arrive-by:apply",
  /** Results committed to the page; detail is what they show. */
  shown: "ptn:arrive-by:shown",
  /** H73: the applied search's effect started. */
  effect: "ptn:arrive-by:effect",
  /** H73: `prepareArriveBy` ended; detail `ArriveByPreparedMark`. */
  prepared: "ptn:arrive-by:prepared",
  /** H73: the cards of one search update were built; detail `ArriveByCardsMark`. */
  cards: "ptn:arrive-by:cards",
  /** H73: those cards were handed to React; detail `{ status }`. */
  view: "ptn:arrive-by:view",
  /** H73: the first frame after a result's commit; detail `{ status }`. */
  frame: "ptn:arrive-by:frame",
} as const;

/** Who prepared the query: the applied search, or a warm-up's trigger. */
export type ArriveByCaller = "apply" | "results" | "choice";

/** Times are `performance.now()` milliseconds; each step's end in order. */
export interface ArriveByPreparedMark {
  readonly caller: ArriveByCaller;
  readonly start: number;
  readonly stopsRead: number;
  readonly reachable?: number;
  readonly resolveTime?: number;
  readonly lookup?: number;
  readonly stops: number;
}

export interface ArriveByCardsMark {
  readonly status: string;
  readonly start: number;
  readonly tripsRead: number;
  readonly routesRead: number;
  readonly trips: number;
  /** Route colours known (H73 step 2; step 1 counted route rows). */
  readonly routes: number;
  readonly options: number;
}

export function markArriveBy(name: string, detail?: unknown): void {
  try {
    performance.mark(name, detail === undefined ? undefined : { detail });
  } catch {
    // An unclonable detail or a missing Performance API drops the mark only.
  }
}
