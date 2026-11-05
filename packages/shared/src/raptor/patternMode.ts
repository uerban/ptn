/**
 * Trip-pattern rollout flag. ONE enum, threaded identically into the TS hydrate path, the wasm
 * Index::build, and a mirrored pt-serve CLI/env default.
 * - Off: legacy canonical-only
 * enumeration; byte-identical to pre-pattern.
 * - Unbounded: one RAPTOR route per distinct
 * stop-sequence signature.
 * - CoveringMerge: Unbounded + contiguous-subsequence covering-merge.
 * Implemented; see `coveringMergeFold` in `patternSignature.ts`.
 */
export enum PatternMode {
  Off = "off",
  Unbounded = "unbounded",
  CoveringMerge = "covering-merge",
}

/**
 * The single source of truth the TS path reads and passes through to wasm. The pt-serve binary
 * mirrors this default via its CLI/env; a CI assert (Phase 3) confirms they agree. Default
 * CoveringMerge; set `VITE_PATTERN_MODE=off` to roll back.

 *
 * NOTE: This const is frontend-only — `import.meta.env` is a Vite concept and
 * resolves to `undefined` in Node, giving `CoveringMerge` as the default. The
 * backend (`index-builder`) reads `PT_PATTERN_MODE`; pt-serve reads
 * `--pattern-mode`. Those are separate env sources wired in later phases.
 */
export const PATTERN_MODE: PatternMode =
  ((import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_PATTERN_MODE as PatternMode | undefined) ?? PatternMode.CoveringMerge;

export const patternsEnabled = (m: PatternMode): boolean => m !== PatternMode.Off;
