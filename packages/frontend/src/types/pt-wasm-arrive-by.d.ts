// Hand-written ambient declaration for the opt-in arrive-by package
// (`crates/pt-wasm/pkg-web-arrive-by`, built by
// `scripts/build-pt-wasm-arrive-by.mjs`). Only a PTN_ARRIVE_BY_EXPERIMENT=1
// Vite build resolves the module; this declaration lets tsc check the opt-in
// worker without the package being built. Keep it in step with
// `crates/pt-wasm/src/temporal_deadline.rs`.
declare module "@pt/wasm-arrive-by" {
  export default function init(input?: unknown): Promise<unknown>;

  export class TemporalDeadlineProbe {
    constructor(ptb: Uint8Array, ptft: Uint8Array, mode: string);
    static withImmutableBinding(ptb: Uint8Array, ptft: Uint8Array, mode: string): TemporalDeadlineProbe;
    prepare(query: unknown, options: unknown): unknown;
    run_winner_journeys(goal: string, suffix: string): unknown;
    latestDeparture(query: unknown, windowStart: number, windowEnd: number, arrivalDeadline: number): unknown;
    selectorDeparture(goal: string, query: unknown, windowStart: number, windowEnd: number,
      arrivalDeadline: number): unknown;
    free(): void;
  }
}
