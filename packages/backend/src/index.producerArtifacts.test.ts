import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import * as fs from "node:fs";
import { buildProducerArtifacts, producerArtifactsResolvers } from "./index.js";
import type {
  ProducerArtifacts,
  ProducerArtifactsDeps,
} from "./gtfs/producerArtifacts.js";

const tmpDirs: string[] = [];

/**
 * Lay out a published data root the way the probe (`refresh.rs`) does:
 *   <dataRoot>/current.json                          → { generationId }
 *   <dataRoot>/generations/<gen>/generation.json     → { tripRouteSha256, stopCellSha256, ... }
 *   <dataRoot>/generations/<gen>/trip-route.json     → interned trip→route map
 *   <dataRoot>/generations/<gen>/stop-cell.json      → stop→tileCoords map
 */
function mkDataRoot(
  generationId: string,
  files: Record<string, string>,
): string {
  const dataRoot = mkdtempSync(join(tmpdir(), "ptn-index-producer-artifacts-"));
  tmpDirs.push(dataRoot);
  const genDir = join(dataRoot, "generations", generationId);
  mkdirSync(genDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(genDir, name), body);
  }
  const tripRoute = files["trip-route.json"];
  const stopCell = files["stop-cell.json"];
  const generationManifest: Record<string, unknown> = {
    schemaVersion: 1,
    generationId,
  };
  if (tripRoute !== undefined) {
    generationManifest.tripRouteSha256 = createHash("sha256").update(tripRoute).digest("hex");
  }
  if (stopCell !== undefined) {
    generationManifest.stopCellSha256 = createHash("sha256").update(stopCell).digest("hex");
  }
  writeFileSync(join(genDir, "generation.json"), JSON.stringify(generationManifest));
  writeFileSync(
    join(dataRoot, "current.json"),
    JSON.stringify({ manifestSchemaVersion: 1, generationId, citySlug: "testcity" }),
  );
  return dataRoot;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("buildProducerArtifacts", () => {
  it("returns null in backend mode (default), regardless of PT_DATA_ROOT", () => {
    const dataRoot = mkDataRoot("a".repeat(64), {
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    expect(
      buildProducerArtifacts({ PT_SCHEDULE_TILE_SOURCE: "backend", PT_DATA_ROOT: dataRoot }),
    ).toBeNull();
    // Default (env var unset) is backend mode.
    expect(buildProducerArtifacts({ PT_DATA_ROOT: dataRoot })).toBeNull();
  });

  it("constructs a working loader in producer mode (reads current.json + generation.json)", () => {
    const gen = "a".repeat(64);
    const dataRoot = mkDataRoot(gen, {
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const artifacts = buildProducerArtifacts({
      PT_SCHEDULE_TILE_SOURCE: "producer",
      PT_DATA_ROOT: dataRoot,
    });
    expect(artifacts).not.toBeNull();
    // The derived resolvers must read the on-disk current.json/generation.json
    // and SHA-verify the two artifacts against generation.json.
    expect(artifacts!.routeForTrip("T1")).toBe("R1");
    expect(artifacts!.tileCoordsForStop("S1")).toBe("3_4");
    expect(artifacts!.routeForTrip("GHOST")).toBeUndefined();
    expect(artifacts!.artifactsPresent()).toEqual({ tripRoute: true, stopCell: true });
  });

  it("producer mode with no PT_DATA_ROOT resolves to an empty (absent-maps) loader", () => {
    const artifacts = buildProducerArtifacts({ PT_SCHEDULE_TILE_SOURCE: "producer" });
    expect(artifacts).not.toBeNull();
    expect(artifacts!.tileCoordsForStop("S1")).toBeUndefined();
    expect(artifacts!.artifactsPresent()).toEqual({ tripRoute: false, stopCell: false });
  });

  it("uses an injected createArtifacts factory + resolver deps when provided", () => {
    const fake: ProducerArtifacts = {
      routeForTrip: vi.fn(() => "RX"),
      routeLookup: vi.fn(() => () => "RX"),
      tileCoordsForStop: vi.fn(() => "9_9"),
      artifactsPresent: () => ({ tripRoute: true, stopCell: true }),
      loadedShas: () => ({}),
      loadedGenerationId: () => null,
    };
    const createArtifacts = vi.fn((_d: ProducerArtifactsDeps) => fake);
    const artifacts = buildProducerArtifacts(
      { PT_SCHEDULE_TILE_SOURCE: "producer" },
      { createArtifacts },
    );
    expect(artifacts).toBe(fake);
    expect(createArtifacts).toHaveBeenCalledTimes(1);
    // The factory must have been handed the single `readGeneration` resolver
    // (I-1: one current.json + generation.json read per resolution).
    const passed = createArtifacts.mock.calls[0][0];
    expect(typeof passed.readGeneration).toBe("function");
  });

  // I-1: `readGeneration()` resolves generationId + dir + shas from ONE
  // current.json read (+ one generation.json read). Assert the resolved snapshot
  // is internally coherent (id matches the dir the SHAs were read from) and that
  // a generationId + dir is still returned even when generation.json is absent
  // (no SHAs ⇒ artifacts absent), which proves the dir/id come from the single
  // current.json read, not gated on a successful generation.json read.
  it("readGeneration returns one coherent {generationId, dir, shas} snapshot", () => {
    const gen = "a".repeat(64);
    const dataRoot = mkDataRoot(gen, {
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const { readGeneration } = producerArtifactsResolvers(dataRoot);
    const resolved = readGeneration();
    expect(resolved?.generationId).toBe(gen);
    expect(resolved?.dir).toBe(join(dataRoot, "generations", gen));
    expect(typeof resolved?.shas.tripRoute).toBe("string");
    expect(typeof resolved?.shas.stopCell).toBe("string");

    // Remove generation.json: the id + dir still resolve (from the one
    // current.json read); only the SHAs go absent.
    fs.rmSync(join(dataRoot, "generations", gen, "generation.json"));
    const noManifest = readGeneration();
    expect(noManifest?.generationId).toBe(gen);
    expect(noManifest?.dir).toBe(join(dataRoot, "generations", gen));
    expect(noManifest?.shas).toEqual({});
  });
});
