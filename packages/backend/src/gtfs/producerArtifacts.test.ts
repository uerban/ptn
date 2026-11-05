import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { createProducerArtifacts } from "./producerArtifacts.js";

const tmpDirs: string[] = [];

function mkGenDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ptn-producer-artifacts-"));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function sha(dir: string, name: string): string {
  return createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("createProducerArtifacts", () => {
  it("loads + caches trip-route and stop-cell maps keyed on generationId", () => {
    const dir = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const tripRouteSha = sha(dir, "trip-route.json");
    const stopCellSha = sha(dir, "stop-cell.json");
    const src = createProducerArtifacts({
      readGeneration: () => ({ generationId: "gen1", dir, shas: { tripRoute: tripRouteSha, stopCell: stopCellSha } }),
    });
    expect(src.routeForTrip("T1")).toBe("R1");
    expect(src.tileCoordsForStop("S1")).toBe("3_4");
    expect(src.routeForTrip("UNKNOWN")).toBeUndefined(); // unknown key => undefined (caller skips)
    expect(src.tileCoordsForStop("UNKNOWN")).toBeUndefined();
    expect(src.artifactsPresent()).toEqual({ tripRoute: true, stopCell: true });
    // Cache hit: mutate the on-disk artifacts after the first load. The cached
    // parsed maps must persist — a cache hit on an unchanged generationId must
    // NOT re-read the artifact bodies (it would now SHA-mismatch and go absent).
    writeFileSync(join(dir, "trip-route.json"), JSON.stringify({ routes: ["MUTATED"], trips: { T1: 0 } }));
    writeFileSync(join(dir, "stop-cell.json"), JSON.stringify({ S1: "9_9" }));
    expect(src.routeForTrip("T1")).toBe("R1"); // still cached
    expect(src.tileCoordsForStop("S1")).toBe("3_4"); // still cached
  });

  it("resolves a pathological Object.prototype key (__proto__) end-to-end", () => {
    // A GTFS trip_id / stop_id is an arbitrary string and may legally be
    // `__proto__`. The emitter writes it via a null-prototype object so it
    // lands as an own JSON key; the loader must round-trip it (JSON.parse makes
    // it an own key, Object.entries + Map preserves it). A regression — the
    // emitter reverting to a plain `{}`, or the loader to `obj[key]` lookups —
    // would silently drop that trip's RT / that stop's departures.
    // NOTE: the fixtures are RAW JSON strings; an object literal `{__proto__:0}`
    // would set the prototype (the very footgun under test), not create a key.
    const dir = mkGenDir({
      "trip-route.json": '{"routes":["R9"],"trips":{"__proto__":0,"T1":0}}',
      "stop-cell.json": '{"__proto__":"3_4","S1":"5_6"}',
    });
    const src = createProducerArtifacts({
      readGeneration: () => ({
        generationId: "genproto",
        dir,
        shas: { tripRoute: sha(dir, "trip-route.json"), stopCell: sha(dir, "stop-cell.json") },
      }),
    });
    expect(src.routeForTrip("__proto__")).toBe("R9");
    expect(src.tileCoordsForStop("__proto__")).toBe("3_4");
    expect(src.routeForTrip("T1")).toBe("R9");
    expect(src.tileCoordsForStop("S1")).toBe("5_6");
  });

  it("does ONE current.json read per resolution (readGeneration called once per current())", () => {
    const dir = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const readGeneration = vi.fn(() => ({
      generationId: "gen1",
      dir,
      shas: { tripRoute: sha(dir, "trip-route.json"), stopCell: sha(dir, "stop-cell.json") },
    }));
    const src = createProducerArtifacts({ readGeneration });
    // A single map lookup resolves `current()` exactly once (one readGeneration).
    src.routeForTrip("T1");
    expect(readGeneration.mock.calls.length).toBe(1);
    // `routeLookup()` (the B2 hot-path resolver) resolves `current()` once and
    // hands back a pure closure — running it many times does NO further reads.
    const lookup = src.routeLookup();
    readGeneration.mockClear();
    for (let i = 0; i < 10; i++) lookup("T1");
    expect(readGeneration.mock.calls.length).toBe(0);
  });

  it("returns undefined maps when an artifact is absent or SHA-mismatched", () => {
    const dir = mkGenDir({}); // no files
    const src = createProducerArtifacts({
      readGeneration: () => ({ generationId: "g", dir, shas: {} }),
    });
    expect(src.tileCoordsForStop("S1")).toBeUndefined();
    expect(src.routeForTrip("T1")).toBeUndefined();
    expect(src.artifactsPresent().stopCell).toBe(false); // for /health/ready + metrics
    expect(src.artifactsPresent().tripRoute).toBe(false);
  });

  it("returns absent maps when readGeneration resolves null (cold start / mid-publish)", () => {
    const src = createProducerArtifacts({ readGeneration: () => null });
    expect(src.routeForTrip("T1")).toBeUndefined();
    expect(src.tileCoordsForStop("S1")).toBeUndefined();
    expect(src.artifactsPresent()).toEqual({ tripRoute: false, stopCell: false });
    expect(src.routeLookup()("T1")).toBeUndefined();
  });

  it("treats a SHA-mismatched artifact as absent", () => {
    const dir = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const src = createProducerArtifacts({
      readGeneration: () => ({ generationId: "g", dir, shas: { tripRoute: "0".repeat(64), stopCell: "0".repeat(64) } }),
    });
    expect(src.routeForTrip("T1")).toBeUndefined();
    expect(src.tileCoordsForStop("S1")).toBeUndefined();
    expect(src.artifactsPresent()).toEqual({ tripRoute: false, stopCell: false });
  });

  it("re-reads on a generation roll", () => {
    const dirA = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["RA"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "1_1" }),
    });
    const dirB = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["RB"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "2_2" }),
    });
    let gen = "genA";
    let dir = dirA;
    const src = createProducerArtifacts({
      readGeneration: () => ({
        generationId: gen,
        dir,
        shas:
          gen === "genA"
            ? { tripRoute: sha(dirA, "trip-route.json"), stopCell: sha(dirA, "stop-cell.json") }
            : { tripRoute: sha(dirB, "trip-route.json"), stopCell: sha(dirB, "stop-cell.json") },
      }),
    });
    expect(src.routeForTrip("T1")).toBe("RA");
    expect(src.tileCoordsForStop("S1")).toBe("1_1");
    gen = "genB";
    dir = dirB;
    expect(src.routeForTrip("T1")).toBe("RB");
    expect(src.tileCoordsForStop("S1")).toBe("2_2");
  });

  it("exposes loadedShas for the loaded generation", () => {
    const dir = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const expected = { tripRoute: sha(dir, "trip-route.json"), stopCell: sha(dir, "stop-cell.json") };
    const src = createProducerArtifacts({
      readGeneration: () => ({ generationId: "gen1", dir, shas: expected }),
    });
    src.routeForTrip("T1"); // trigger load
    expect(src.loadedShas()).toEqual(expected);
  });

  it("exposes loadedGenerationId (the cache key) for /health/ready diagnosis", () => {
    const dir = mkGenDir({
      "trip-route.json": JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }),
      "stop-cell.json": JSON.stringify({ S1: "3_4" }),
    });
    const src = createProducerArtifacts({
      readGeneration: () => ({
        generationId: "gen-abc",
        dir,
        shas: { tripRoute: sha(dir, "trip-route.json"), stopCell: sha(dir, "stop-cell.json") },
      }),
    });
    expect(src.loadedGenerationId()).toBe("gen-abc");

    // Cold start (nothing resolves) ⇒ null.
    const cold = createProducerArtifacts({ readGeneration: () => null });
    expect(cold.loadedGenerationId()).toBeNull();
  });
});
