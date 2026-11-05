/**
 * Stub the PTB catalog transport for unit tests.
 *
 * `syncGtfsData` has one catalog path: read `/api/<city>/ready` for the
 * generation, fetch `/api/<city>/raptor-bundle` for the bytes, decode them in a
 * worker. Tests that only care about what `syncGtfsData` persists use this
 * helper to speak the PTB path directly. This keeps that boilerplate in one
 * place rather than in every suite.
 *
 * Two halves, because one of them has to be hoisted:
 *
 * 1. `installPtbCatalogFetch()` — call it in `beforeEach`. Stubs `fetch` for
 *    the two catalog endpoints and leaves everything else alone.
 * 2. The worker decode — mock it per file, reading the wire object out of
 *    `ptbCatalogState`:
 *
 * ```ts
 * vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
 *   const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
 *   return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
 * });
 * ```
 *
 * The dynamic import inside the factory is what makes it hoisting-safe: the
 * factory runs when the mocked module is first imported, by which point the
 * helper module is loadable, and it reads `wire` at CALL time so a test can
 * set it in `beforeEach`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, FIXTURE_REL))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error(`ptbCatalog helper: could not locate repo root from ${process.cwd()}`);
}

const FIXTURE_REL = "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb";

/**
 * Real PTB bytes, not a placeholder.
 *
 * The decode is stubbed, so the CONTENT is irrelevant to what gets persisted —
 * but the bytes are still written to IndexedDB and handed to the eager wasm
 * router init on the way past. Junk bytes make that init throw an unhandled
 * rejection that surfaces in unrelated suites.
 */
const FIXTURE_BYTES = new Uint8Array(readFileSync(resolve(findRepoRoot(), FIXTURE_REL)));

/** The 64-hex generation id the stubbed `/ready` advertises. */
export const STUB_GENERATION_ID = "d".repeat(64);
/** The bundle ETag that pairs with it — `fetchCatalog` requires exactly this. */
export const STUB_ETAG = `"${STUB_GENERATION_ID}"`;

export interface PtbCatalogState {
  /** Whatever the worker decode should return. */
  wire: unknown;
  /** Advertised generation; override to simulate a generation swap. */
  generationId: string;
  /** Shapes sidecar provenance, or `null` for a generation without one. */
  shapes: { hash: string; sizeBytes: number } | null;
  /** Transfers provenance headers on the bundle response. */
  transfers: { url: string; hash: string; sizeBytes: number } | null;
  /** Bytes served at `/raptor-bundle`. */
  bytes: Uint8Array;
}

export const ptbCatalogState: PtbCatalogState = {
  wire: null,
  generationId: STUB_GENERATION_ID,
  shapes: null,
  transfers: null,
  bytes: FIXTURE_BYTES,
};

/** Reset to defaults. Call before setting per-test overrides. */
export function resetPtbCatalogState(): void {
  ptbCatalogState.wire = null;
  ptbCatalogState.generationId = STUB_GENERATION_ID;
  ptbCatalogState.shapes = null;
  ptbCatalogState.transfers = null;
  ptbCatalogState.bytes = FIXTURE_BYTES;
}

function readyBody(cityId: string): Record<string, unknown> {
  return {
    status: "ready",
    city: cityId,
    servingGenerationId: ptbCatalogState.generationId,
    generationAgeSecs: 60,
    cityTzIana: "Europe/Vilnius",
    servingShapesJsonSha256: ptbCatalogState.shapes?.hash ?? null,
    servingShapesJsonSizeBytes: ptbCatalogState.shapes?.sizeBytes ?? null,
    nowUnixSecs: 1_800_000_000,
    // Must match `PATTERN_MODE`, which `parsePtbCatalogGeneration` compares
    // against — a mismatch is rejected as a half-deployed generation.
    patternMode: "covering-merge",
  };
}

/**
 * Install the `fetch` stub. Requests to anything other than the two catalog
 * endpoints reject, so a test that starts depending on another endpoint finds
 * out rather than silently hitting the real network.
 */
export function installPtbCatalogFetch(cityId = "vilnius"): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/api/${cityId}/ready`)) {
      return new Response(JSON.stringify(readyBody(cityId)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith(`/api/${cityId}/raptor-bundle`)) {
      const headers: Record<string, string> = {
        etag: `"${ptbCatalogState.generationId}"`,
        "content-type": "application/octet-stream",
        // Capability marker: its ABSENCE tells the client "server without the
        // marker, keep the cached transfers", which would make these tests depend on
        // cross-test cache state.
        "x-pt-raptor-bundle-provenance": "transfers-v1",
      };
      if (ptbCatalogState.transfers) {
        headers["x-pt-transfers-artifact-url"] = ptbCatalogState.transfers.url;
        headers["x-pt-transfers-artifact-hash"] = ptbCatalogState.transfers.hash;
        headers["x-pt-transfers-artifact-size"] = String(ptbCatalogState.transfers.sizeBytes);
      }
      // `as unknown as BodyInit`: TS's lib.dom overload set does not include a
      // bare `Uint8Array`, though every runtime accepts one.
      return new Response(ptbCatalogState.bytes as unknown as BodyInit, { status: 200, headers });
    }
    throw new Error(`ptbCatalog stub: unexpected fetch ${url}`);
  }));
}
