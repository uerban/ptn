// Hand-written ambient declaration for the wasm-pack package.
//
// It shadows the generated `pkg-web/pt_wasm.d.ts`, so anything exported from
// pt-wasm that is not listed here is invisible to tsc no matter what wasm-pack
// emitted. Keep it in step with `crates/pt-wasm/src/lib.rs` — a missing entry
// surfaces as "Property X is missing in type 'typeof import(\"@pt/wasm\")'",
// which reads like a stale build and is not one.
declare module "@pt/wasm" {
  export default function init(input?: unknown): Promise<unknown>;

  export class PtRouter {
    constructor(bytes: Uint8Array, modeStr: string);
    plan(query: unknown): unknown;
    /** PTB v2 service-day resolution; a v1 bundle rejects. */
    resolveTime(departureUnix: number): unknown;
    setTransfers(bytes: Uint8Array): void;
    free(): void;
    isAlive(): boolean;
  }

  /** Local address search over a packed address artifact (`PTAS`, schema 1). */
  export class PtAddressIndex {
    constructor(bytes: Uint8Array);
    search(
      query: string,
      limit: number,
    ): {
      label: string;
      lat: number;
      lon: number;
      rowId: number;
      matchedKey: string;
      exact: boolean;
    }[];
    rowCount(): number;
    keyCount(): number;
    fstSizeBytes(): number;
    cityId(): string | undefined;
    free(): void;
  }
  /** On-device walking routes over a PTWG v2 walk graph. */
  export class PtWalkGraph {
    /** Throws on bad bytes (truncated, corrupt, or too large to index). */
    constructor(bytes: Uint8Array);
    cityId(): string;
    /** Points of the graph (uncontracted nodes). */
    nodeCount(): number;
    /** Junctions of the contracted graph. */
    junctionCount(): number;
    /**
     * The walk, or `null` when there is no walkable route, including when a
     * coordinate is not finite or out of range (not an error). Throws on an
     * unknown profile.
     */
    route(
      fromLat: number,
      fromLon: number,
      toLat: number,
      toLon: number,
      profile: "default" | "wheelchair",
    ): {
      coords: [number, number][];
      distanceMeters: number;
      steps: {
        kind: "depart" | "turn" | "cross" | "stairs" | "arrive";
        turn?:
          | "straight"
          | "slight-left"
          | "slight-right"
          | "left"
          | "right"
          | "sharp-left"
          | "sharp-right"
          | "u-turn";
        name: string;
        distanceMeters: number;
        startIndex: number;
      }[];
    } | null;
    free(): void;
  }
}
