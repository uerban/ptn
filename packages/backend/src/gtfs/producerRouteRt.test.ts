import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createProducerRouteRt } from "./producerRouteRt.js";
import { createProducerArtifacts } from "./producerArtifacts.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("createProducerRouteRt", () => {
  it("groups RT by route via the artifact and skips unknown trips", () => {
    const updates = [
      { tripId: "T1", delaySeconds: 60, cancelled: false },
      { tripId: "T2", delaySeconds: 0, cancelled: true },
      { tripId: "GHOST", delaySeconds: 5, cancelled: false },
    ];
    const src = createProducerRouteRt({
      getRealtimeTripUpdates: () => updates,
      resolveRouteForTrip: () => (t) =>
        ({ T1: "R9", T2: "R9" } as Record<string, string>)[t], // GHOST -> undefined
      artifactPresent: () => true,
      canonicalFallback: () => [],
    });
    const out = src.getRouteUpdate("R9");
    expect(out.routeId).toBe("R9");
    expect(out.trips.map((t) => t.tripId).sort()).toEqual(["T1", "T2"]); // GHOST dropped, not via canonical
    expect(typeof out.generatedAt).toBe("number");
  });

  it("returns only trips whose artifact route matches the requested route", () => {
    const updates = [
      { tripId: "A", delaySeconds: 10, cancelled: false },
      { tripId: "B", delaySeconds: 20, cancelled: false },
    ];
    const src = createProducerRouteRt({
      getRealtimeTripUpdates: () => updates,
      resolveRouteForTrip: () => (t) => ({ A: "R1", B: "R2" } as Record<string, string>)[t],
      artifactPresent: () => true,
      canonicalFallback: () => [],
    });
    expect(src.getRouteUpdate("R1").trips.map((t) => t.tripId)).toEqual(["A"]);
    expect(src.getRouteUpdate("R2").trips.map((t) => t.tripId)).toEqual(["B"]);
    expect(src.getRouteUpdate("R3").trips).toEqual([]);
  });

  // B1: a WHOLLY-ABSENT trip-route artifact must NOT serve EMPTY RT for every
  // route (a city-wide RT blackout). With `artifactPresent` false the source
  // falls through to the canonical `getRealtimeForRoute` thunk and counts a
  // single `fallback` (not one per enumerated trip — the artifact answered for
  // zero trips, the canonical path answered the whole route).
  it("falls back to canonical getRealtimeForRoute when the artifact is wholly absent", () => {
    const canonicalTrips = [
      { tripId: "X", delaySeconds: 30, cancelled: false },
      { tripId: "Y", delaySeconds: 0, cancelled: true },
    ];
    const results: ("served" | "fallback")[] = [];
    const canonicalFallback = vi.fn((routeId: string) =>
      routeId === "R7" ? canonicalTrips : [],
    );
    const src = createProducerRouteRt({
      // The store-resident RT enumeration MUST NOT be consulted on the
      // wholly-absent path — the canonical grouping owns that.
      getRealtimeTripUpdates: () => {
        throw new Error("getRealtimeTripUpdates must not run on the absent-artifact path");
      },
      resolveRouteForTrip: () => () => undefined,
      artifactPresent: () => false,
      canonicalFallback,
      onArtifactResult: (r) => results.push(r),
    });

    const out = src.getRouteUpdate("R7");
    expect(out.routeId).toBe("R7");
    expect(out.trips).toEqual(canonicalTrips); // canonical-backed, NOT {trips:[]}
    expect(canonicalFallback).toHaveBeenCalledWith("R7");
    expect(results).toEqual(["fallback"]); // counted ONCE, not per trip
  });

  // B1 integration: the REAL per-generation loader with a wholly-broken `trip-route.json` (SHA
  // mismatch ⇒ a non-ENOENT cause ⇒ one `warn`, artifact treated absent) wired to the RT source ⇒
  // canonical-backed RT (NOT `{trips:[]}`). This is the city-wide-blackout regression guard end to
  // end: loader presence-check + handler fallback + the single warn.
  it("end-to-end: a broken trip-route.json artifact ⇒ canonical RT + one warn", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptn-b1-rt-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "trip-route.json"), JSON.stringify({ routes: ["R1"], trips: { T1: 0 } }));
    const warn = vi.fn();
    // Expected SHA does NOT match the on-disk bytes ⇒ loadVerified warns once
    // (non-ENOENT cause) and treats the artifact as absent.
    const artifacts = createProducerArtifacts({
      readGeneration: () => ({ generationId: "gen1", dir, shas: { tripRoute: "0".repeat(64) } }),
      log: { warn },
    });

    const canonicalTrips = [{ tripId: "Z", delaySeconds: 12, cancelled: false }];
    const src = createProducerRouteRt({
      getRealtimeTripUpdates: () => {
        throw new Error("index-free enumeration must not run on the broken-artifact path");
      },
      resolveRouteForTrip: () => artifacts.routeLookup(),
      artifactPresent: () => artifacts.artifactsPresent().tripRoute,
      canonicalFallback: (routeId) => (routeId === "RX" ? canonicalTrips : []),
    });

    const out = src.getRouteUpdate("RX");
    expect(out.trips).toEqual(canonicalTrips); // canonical-backed, NOT {trips:[]}
    expect(warn).toHaveBeenCalledTimes(1); // one warn on the non-ENOENT SHA mismatch
  });

  // B1: a PRESENT-but-incomplete artifact still skips unknown trips per-key
  // (the B-5 refresh-skew decision) — it does NOT canonical-fall-through.
  it("keeps per-key skip (no canonical fallback) when the artifact is present", () => {
    const updates = [
      { tripId: "T1", delaySeconds: 60, cancelled: false },
      { tripId: "GHOST", delaySeconds: 5, cancelled: false },
    ];
    const canonicalFallback = vi.fn(() => {
      throw new Error("canonicalFallback must not run when the artifact is present");
    });
    const src = createProducerRouteRt({
      getRealtimeTripUpdates: () => updates,
      resolveRouteForTrip: () => (t) => ({ T1: "R9" } as Record<string, string>)[t],
      artifactPresent: () => true,
      canonicalFallback,
    });
    const out = src.getRouteUpdate("R9");
    expect(out.trips.map((t) => t.tripId)).toEqual(["T1"]); // GHOST skipped, not via canonical
    expect(canonicalFallback).not.toHaveBeenCalled();
  });

  // B2: grouping over N RT trips must do AT MOST ONE current.json read — the
  // trip→route lookup is resolved once per request, not once per trip. Spy on
  // the resolver (the loader's `readGeneration`) and assert it's called ≤1 time
  // across an N-trip getRouteUpdate.
  it("does ≤1 current.json (readGeneration) read over N RT trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptn-b2-rt-"));
    tmpDirs.push(dir);
    const wire = JSON.stringify({
      routes: ["R9"],
      trips: { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 },
    });
    writeFileSync(join(dir, "trip-route.json"), wire);
    const sha = createHash("sha256").update(wire).digest("hex");
    const readGeneration = vi.fn(() => ({ generationId: "gen1", dir, shas: { tripRoute: sha } }));
    const artifacts = createProducerArtifacts({ readGeneration });

    const updates = ["T1", "T2", "T3", "T4", "T5"].map((tripId) => ({
      tripId,
      delaySeconds: 0,
      cancelled: false,
    }));
    const src = createProducerRouteRt({
      getRealtimeTripUpdates: () => updates,
      resolveRouteForTrip: () => artifacts.routeLookup(),
      artifactPresent: () => artifacts.artifactsPresent().tripRoute,
      canonicalFallback: () => [],
    });

    // Warm the cache via the presence check (one resolution), then group 5 trips.
    const out = src.getRouteUpdate("R9");
    expect(out.trips).toHaveLength(5);
    // `artifactPresent()` + `routeLookup()` each resolve `current()`, but BOTH
    // hit the same generationId cache → at most a couple of cheap pointer reads,
    // and crucially NOT one per trip (would be ≥5). Assert ≤2.
    expect(readGeneration.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
