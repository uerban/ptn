/**
 * The five on-device routing engine-failure signals. Single source of truth shared by the
 * frontend classifier and the backend /client-report allowlist so the two cannot drift.
 */
export const ENGINE_FAILURE_KINDS = ["no-wasm", "import", "init", "query", "other"] as const;
export type EngineFailureKind = (typeof ENGINE_FAILURE_KINDS)[number];
