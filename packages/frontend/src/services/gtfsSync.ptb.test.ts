import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.ts";
import { api } from "./api.ts";
import { syncGtfsData } from "./gtfsSync.ts";

vi.mock("./gtfsQuotaGuard.ts", () => ({
  shouldWriteShapes: vi.fn(async () => true),
  resetQuotaGuardForSync: vi.fn(),
}));

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error(`gtfsSync.ptb.test: could not locate repo root from ${process.cwd()}`);
}

const PTB = new Uint8Array(readFileSync(
  resolve(findRepoRoot(), "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb"),
));
const GENERATION_ID = "d".repeat(64);
const ETAG = `"${GENERATION_ID}"`;
const ORIGINAL_FETCH = globalThis.fetch;

function readyBody(
  shapesArtifact?: { hash: string; sizeBytes: number },
): Record<string, unknown> {
  return {
    status: "ready",
    city: "vilnius",
    servingGenerationId: GENERATION_ID,
    generationAgeSecs: 60,
    cityTzIana: "Europe/Vilnius",
    servingShapesJsonSha256: shapesArtifact?.hash ?? null,
    servingShapesJsonSizeBytes: shapesArtifact?.sizeBytes ?? null,
    nowUnixSecs: 1_800_000_000,
    patternMode: "covering-merge",
  };
}

describe("syncGtfsData PTB catalog", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.stubGlobal("Worker", undefined);
    if (db.isOpen()) await db.close();
    await Dexie.delete("ptn");
    await db.open();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("populates the existing catalog tables/blob from the PTB bytes", async () => {
    let bundleRequests = 0;
    let transfersHash = "first-transfer";
    const readyState: {
      shapesArtifact?: { hash: string; sizeBytes: number };
    } = {};
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/vilnius/ready")) {
        return new Response(JSON.stringify(readyBody(readyState.shapesArtifact)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/vilnius/raptor-bundle")) {
        bundleRequests += 1;
        const headers = new Headers(init?.headers);
        if (headers.get("if-none-match") === ETAG) {
          return new Response(null, {
            status: 304,
            headers: {
              etag: ETAG,
              "X-PT-City-Tz-Iana": "Europe/Vilnius",
              "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
              "X-PT-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
              "X-PT-Transfers-Artifact-Hash": transfersHash,
              "X-PT-Transfers-Artifact-Size": "42",
            },
          });
        }
        return new Response(PTB as unknown as BodyInit, {
          status: 200,
          headers: {
            etag: ETAG,
            "content-type": "application/octet-stream",
            "X-PT-City-Tz-Iana": "Europe/Vilnius",
            "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
            "X-PT-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
            "X-PT-Transfers-Artifact-Hash": transfersHash,
            "X-PT-Transfers-Artifact-Size": "42",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(syncGtfsData("vilnius")).resolves.toBe(true);
    expect(await db.gtfsStops.count()).toBeGreaterThan(0);
    expect(await db.gtfsRoutes.count()).toBeGreaterThan(0);
    expect(await db.gtfsBundle.get("vilnius")).toBeDefined();
    expect(await db.gtfsSyncMeta.get("current")).toMatchObject({
      cityId: "vilnius",
      etag: ETAG,
      generationId: GENERATION_ID,
      transfersHash: "first-transfer",
    });

    // A stable generation + 304 revalidation takes the no-decode fast path.
    await expect(syncGtfsData("vilnius")).resolves.toBe(false);
    expect(bundleRequests).toBe(2);

    // Transfer provenance is refreshed even when the PTB body itself is 304.
    // A changed sidecar hash must invalidate the no-decode catalog fast path.
    transfersHash = "second-transfer";
    await expect(syncGtfsData("vilnius")).resolves.toBe(true);
    expect(bundleRequests).toBe(3);
    expect(await db.gtfsSyncMeta.get("current")).toMatchObject({
      transfersHash: "second-transfer",
    });

    // Shapes are sidecars too: their hash can change without changing PTB ETag
    // or bundle-derived generation id, so it also invalidates the fast path.
    readyState.shapesArtifact = { hash: "a".repeat(64), sizeBytes: 42 };
    const shapesArtifact = readyState.shapesArtifact;
    const fetchShapes = vi.spyOn(api, "fetchShapesArtifact").mockResolvedValue({
      hash: shapesArtifact.hash,
      shapes: [],
    });
    await expect(syncGtfsData("vilnius")).resolves.toBe(true);
    expect(bundleRequests).toBe(4);
    expect(fetchShapes).toHaveBeenCalledWith(
      `/api/vilnius/gtfs/shapes/shapes-${shapesArtifact.hash}.json`,
      shapesArtifact.hash,
    );
    expect(await db.gtfsSyncMeta.get("current")).toMatchObject({
      shapesHash: shapesArtifact.hash,
    });

    // A stale refresh that loses the network keeps the valid local catalog,
    // but must not pretend it received a server revalidation.
    const syncedAt = (await db.gtfsSyncMeta.get("current"))!.lastSynced;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    await expect(syncGtfsData("vilnius", {requireNetwork: true})).rejects.toThrow("offline");
    await expect(syncGtfsData("vilnius")).resolves.toBe(false);
    expect((await db.gtfsSyncMeta.get("current"))!.lastSynced).toBe(syncedAt);
  });

  it("keeps the timetable track when only the OSM sidecars change", async () => {
    // Schema-2 generation ids bind the PTB hash and the OSM inputs. The PTB
    // ETag carries the timetable hash alone, so a sidecar-only publication
    // revalidates the PTB with a 304 instead of downloading it again.
    const bundleSha256 = "f".repeat(64);
    const bundleEtag = `"${bundleSha256}"`;
    let generationId = "1".repeat(64);
    let downloads = 0;
    let revalidations = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/vilnius/ready")) {
        return new Response(JSON.stringify({
          ...readyBody(),
          servingGenerationId: generationId,
          servingBundleSha256: bundleSha256,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/vilnius/raptor-bundle")) {
        const headers = { etag: bundleEtag, "X-PT-City-Tz-Iana": "Europe/Vilnius" };
        if (new Headers(init?.headers).get("if-none-match") === bundleEtag) {
          revalidations += 1;
          return new Response(null, { status: 304, headers });
        }
        downloads += 1;
        return new Response(PTB as unknown as BodyInit, {
          status: 200,
          headers: { ...headers, "content-type": "application/octet-stream" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(syncGtfsData("vilnius")).resolves.toBe(true);
    generationId = "2".repeat(64);
    await expect(syncGtfsData("vilnius")).resolves.toBe(true);
    expect(downloads).toBe(1);
    expect(revalidations).toBe(1);
    expect(await db.gtfsSyncMeta.get("current")).toMatchObject({
      etag: bundleEtag,
      generationId,
    });
  });

  it("rejects a PTB response from a different Rust generation", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/vilnius/ready")) {
        return new Response(JSON.stringify(readyBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/vilnius/raptor-bundle")) {
        return new Response(PTB as unknown as BodyInit, {
          status: 200,
          headers: {
            etag: `"${"e".repeat(64)}"`,
            "content-type": "application/octet-stream",
            "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // With no second catalog source left, a mismatched pair has nowhere to
    // fall back TO: the sync fails outright rather than quietly serving the
    // generation whose bytes did not match the advertised one.
    await expect(syncGtfsData("vilnius")).rejects.toThrow(/bundle ETag does not match/);
    expect(await db.gtfsSyncMeta.get("current")).toBeUndefined();
  });

  it("rejects bundle timezone metadata that disagrees with the ready generation", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/vilnius/ready")) {
        return new Response(JSON.stringify(readyBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/vilnius/raptor-bundle")) {
        return new Response(PTB as unknown as BodyInit, {
          status: 200,
          headers: {
            etag: ETAG,
            "content-type": "application/octet-stream",
            "X-PT-City-Tz-Iana": "Europe/Oslo",
            "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(syncGtfsData("vilnius")).rejects.toThrow(
      /bundle timezone does not match ready generation/,
    );
    expect(await db.gtfsSyncMeta.get("current")).toBeUndefined();
  });
});
