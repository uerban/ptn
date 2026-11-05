/**
 * Opt-in arrive-by feature for the owner worker: binds the deadline probe in
 * `@pt/wasm-arrive-by` to the lazy owner. Only the owner worker entry
 * (`ptArriveByOwner.worker.ts`) imports this module.
 *
 * The package's WASM is fetched and instantiated on the first enable, not at
 * worker start, so a rider who never turns the feature on pays only for the
 * glue script and the worker's bundle copy. The normal planner keeps the
 * default `@pt/wasm` binary in its own worker.
 */
import { ArriveByWorkerOwner, type ArriveByOwnerFactory, type RawArriveByOwner } from "./temporalArriveByOwner.ts";

export interface ArriveByWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  /** H84: only the retained-binding factory is used, so the owner hashes the
   * bundle, transfers and layout once when it is built, not in every prepare
   * that does not reuse its catalogue. */
  TemporalDeadlineProbe: { withImmutableBinding(ptb: Uint8Array, ptft: Uint8Array, mode: string): RawArriveByOwner };
}

export interface ArriveByFeature {
  /** For `createArriveByOwnerHost`: snapshots the bundle; constructs nothing. */
  attach(bytes: Uint8Array, mode: string, city: string): ArriveByWorkerOwner;
  /** Instantiates the package once. A failure leaves it unloaded, so a later
   * enable retries (an offline first fetch can succeed later). */
  load(): Promise<void>;
  loaded(): boolean;
}

export function createArriveByFeature(loadModule: () => Promise<ArriveByWasmModule>): ArriveByFeature {
  let probe: ArriveByWasmModule["TemporalDeadlineProbe"] | null = null;
  let loading: Promise<void> | null = null;
  // The owner calls this only for an enabled request, and the host enables
  // only after `load` succeeded; the check keeps a wiring slip a typed
  // `OwnerConstructionFailed` rather than a TypeError.
  const factory: ArriveByOwnerFactory = (ptb, ptft, mode) => {
    if (!probe) throw new Error("arrive-by runtime is not loaded");
    return probe.withImmutableBinding(ptb, ptft, mode);
  };
  return {
    attach: (bytes, mode, city) => new ArriveByWorkerOwner(factory, bytes, mode, city),
    load() {
      if (probe) return Promise.resolve();
      loading ??= (async () => {
        const mod = await loadModule();
        await mod.default();
        const found: unknown = mod.TemporalDeadlineProbe;
        if (typeof found !== "function") throw new Error("arrive-by package has no TemporalDeadlineProbe");
        // Never fall back to the recomputing constructor.
        if (typeof (found as { withImmutableBinding?: unknown }).withImmutableBinding !== "function") {
          throw new Error("arrive-by package has no TemporalDeadlineProbe.withImmutableBinding");
        }
        probe = mod.TemporalDeadlineProbe;
      })().finally(() => { loading = null; });
      return loading;
    },
    loaded: () => probe !== null,
  };
}
