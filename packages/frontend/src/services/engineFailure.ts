import type { EngineFailureKind } from "@pt/shared";
import { wasmSupported } from "./probes.ts";
import {
  PtEngineMisconfiguredError,
  PtWasmImportError, PtWasmInitError, PtWasmQueryError, PtWasmTimeError, PtWasmTransfersError,
} from "./raptorWasm.ts";

/**
 * The five operational signals. `oom` is intentionally absent — the real OOM is the build-time
 * PtRouter decode, not a per-search error. The union itself is the shared `@pt/shared` source
 * of truth; re-exported here so existing local importers keep their import path.
 */
export type { EngineFailureKind } from "@pt/shared";

export function classifyEngineFailure(err: unknown): EngineFailureKind {
  // Pre-flight: if the device can't run wasm at all, every engine error is really the capability
  // gap — classify it first.
  if (!wasmSupported()) return "no-wasm";
  if (err instanceof PtWasmImportError) return "import";
  if (err instanceof PtWasmInitError || err instanceof PtEngineMisconfiguredError) return "init";
  if (err instanceof PtWasmQueryError || err instanceof PtWasmTimeError || err instanceof PtWasmTransfersError) return "query";
  return "other";
}
