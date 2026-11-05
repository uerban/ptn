import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyBaseLogger } from "fastify";
import { zipSync, strToU8 } from "fflate";
import { GtfsScheduler } from "./scheduler.js";
import { metricsRegistry } from "../metrics/registry.js";
import type { BundleManifest } from "@pt/shared";

// The producer-built tiny bundle committed with @pt/shared.
const TINY_PTB = readFileSync(
  new URL("../../../shared/src/ptb/__fixtures__/tiny.ptb", import.meta.url),
);

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  level: "info" as const,
  silent: () => {},
  child: () => noopLogger,
} as unknown as FastifyBaseLogger;

// Drain the setImmediate queue a few times — used after `init()` in cases where
// NO async build is scheduled (e.g. scheduleTileDataDir unset), so there's no
// build counter to poll. Mostly a no-op now that color config is computed
// synchronously inside swap(), but harmless to keep draining: it also lets any
// other queued deferred work (e.g. a load's own setImmediate hops) settle
// before assertions run.
function drainImmediates(times = 4): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  return p;
}

// The async build settles across fs/promises + per-tile setImmediate yields, not a
// fixed setImmediate-hop count — poll the real post-condition instead. THROW on
// timeout so a wiring regression fails loudly instead of silently passing.
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > ms) {
      throw new Error(`waitFor: predicate did not become true within ${ms}ms`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

// Read one labelled value of pt_bundle_build_total (success | failure).
async function bundleBuildCount(status: string): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === "pt_bundle_build_total");
  const v = m?.values.find((s) => s.labels?.status === status);
  return (v?.value as number) ?? 0;
}

// Synthetic 1-stop GTFS feed. `stops.txt` row matches Vilnius centre but
// CITY_ID validation is skipped (we don't pass `cityId`), so the test only
// exercises the canonical/build pipeline.
function writeSyntheticGtfsZip(path: string, routeColor = "FF0000"): void {
  writeFileSync(path, Buffer.from(zipSync({
    "stops.txt": strToU8(
      "stop_id,stop_name,stop_lat,stop_lon\n" +
      "s1,Stop 1,54.6872,25.2797\n",
    ),
    "routes.txt": strToU8(
      "route_id,route_short_name,route_long_name,route_type,route_color\n" +
      `r1,1,Route 1,3,${routeColor}\n`,
    ),
    "trips.txt": strToU8(
      "route_id,service_id,trip_id,trip_headsign\n" +
      "r1,svc,t1,Centras\n",
    ),
    "calendar.txt": strToU8(
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "svc,1,1,1,1,1,1,1,20260101,20301231\n",
    ),
    "stop_times.txt": strToU8(
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
      "t1,08:00:00,08:00:00,s1,1\n",
    ),
  })));
}

describe("GtfsScheduler bundle publishing", () => {
  let tmpDataDir: string;
  let tmpFeedZip: string;
  const prevAllowFileUrls = process.env.PT_ALLOW_FILE_URLS;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), "ptn-scheduler-test-"));
    tmpFeedZip = join(tmpdir(), `ptn-scheduler-feed-${process.pid}-${Date.now()}.zip`);
    process.env.PT_ALLOW_FILE_URLS = "1";
    writeSyntheticGtfsZip(tmpFeedZip);
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
    try { unlinkSync(tmpFeedZip); } catch { /* ignore */ }
    if (prevAllowFileUrls === undefined) {
      delete process.env.PT_ALLOW_FILE_URLS;
    } else {
      process.env.PT_ALLOW_FILE_URLS = prevAllowFileUrls;
    }
  });

  // refreshIntervalHours uses a value that fits int32 ms (24h ≈ 86.4M ms)
  // — values that overflow (e.g. 999h ≈ 3.6G ms) trigger Node's
  // `TimeoutOverflowWarning` and silently clamp the timer to 1ms, which
  // would fire setInterval every millisecond once init resolves and
  // pollute test output.
  const SAFE_REFRESH_HOURS = 24;

  it("writes manifest.json + bundle dir after init", async () => {
    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: noopLogger,
      scheduleTileDataDir: tmpDataDir,
      rtFeedUrls: [],
      keepBundleCount: 1,
    });

    try {
      await scheduler.init();

      const manifestPath = join(tmpDataDir, "manifest.json");
      // Async build settles across fs/promises + per-tile setImmediate — poll the
      // on-disk post-condition (manifest written = build published).
      await waitFor(() => existsSync(manifestPath));
      expect(existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
      expect(manifest.bundleHash).toMatch(/^[0-9a-f]{64}$/);

      // Bundle dir lives at <dataDir>/<bundleHash>/...
      const bundleDir = join(tmpDataDir, manifest.bundleHash);
      expect(existsSync(bundleDir)).toBe(true);

      // Schedule tile dir holds at least one .br tile. Tile-size label
      // comes from `@pt/shared` (`12km` for the launch grid) so we read
      // whatever subdir the bundle wrote rather than hard-coding the label.
      const subdirs = readdirSync(bundleDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(subdirs.length).toBe(1);
      const tileSizeDir = join(bundleDir, subdirs[0]!);
      const tiles = readdirSync(tileSizeDir).filter((f) => f.endsWith(".br"));
      expect(tiles.length).toBeGreaterThan(0);

      // getCurrentBundleHash() reads the manifest off disk → matches.
      expect(scheduler.getCurrentBundleHash()).toBe(manifest.bundleHash);
    } finally {
      scheduler.stop();
    }
  });

  it("does not publish a bundle when scheduleTileDataDir is omitted", async () => {
    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: noopLogger,
      rtFeedUrls: [],
    });

    try {
      await scheduler.init();
      // No scheduleTileDataDir → no build is scheduled; drain any deferred
      // work rather than polling a build counter that will never move.
      await drainImmediates();

      expect(scheduler.getCurrentBundleHash()).toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it("catches and logs a build failure caused by an unwritable dataDir", async () => {
    // Pre-create a regular FILE at the location we'll point dataDir to.
    // `buildBundle.mkdirSync(<file>/<hash>.tmp/<SCHEDULE_TILE_SIZE_LABEL>, {recursive: true})`
    // throws ENOTDIR. The scheduler's catch must swallow the throw, log
    // it, and leave the store ready — exactly the production "transient fs
    // failure" path we want to pin.
    const blockingFile = join(tmpDataDir, "blocked");
    writeFileSync(blockingFile, "regular file, not a directory");

    const errorCalls: { obj: unknown; msg: string }[] = [];
    const errLogger = {
      ...noopLogger,
      error: (obj: unknown, msg: string) => { errorCalls.push({ obj, msg }); },
    } as unknown as FastifyBaseLogger;

    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: errLogger,
      scheduleTileDataDir: blockingFile,
      rtFeedUrls: [],
      keepBundleCount: 1,
    });

    const failBefore = await bundleBuildCount("failure");
    try {
      await scheduler.init();
      // A failed build writes no manifest/dir — poll the failure-counter delta.
      await waitFor(async () => (await bundleBuildCount("failure")) > failBefore);

      // Exactly one error call (the bundle-build catch).
      expect(errorCalls).toHaveLength(1);
      const { obj, msg } = errorCalls[0]!;
      // Payload shape: pin both keys so a refactor that drops `dataDir` or
      // wraps `err` differently fails CI.
      const payload = obj as { err: unknown; dataDir: string };
      expect(payload.dataDir).toBe(blockingFile);
      expect(payload.err).toBeInstanceOf(Error);
      // Message text: pin enough to assert the operator-facing explanation
      // didn't get watered down to "build failed".
      expect(msg).toMatch(/buildAndPublishBundle failed/);
      expect(msg).toMatch(/keep returning their previous bundle/);

      // Store still ready and no manifest written (cold-start failure).
      expect(scheduler.getStore().getGeneration()).toBeGreaterThan(0);
      expect(scheduler.getCurrentBundleHash()).toBeNull();
      // Scheduler-level health is unaffected by the build failure — the
      // load itself succeeded.
      expect(scheduler.lastError).toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it("rejects keepBundleCount < 1 at construction (not at runtime)", () => {
    expect(() => new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: noopLogger,
      scheduleTileDataDir: tmpDataDir,
      rtFeedUrls: [],
      keepBundleCount: 0,
    })).toThrow(/keepBundleCount/);

    expect(() => new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: noopLogger,
      scheduleTileDataDir: tmpDataDir,
      rtFeedUrls: [],
      keepBundleCount: 1.5,
    })).toThrow(/keepBundleCount/);
  });

  it("differing rtFeedUrls produces a different manifest bundleHash", async () => {
    // RT feed URL set is a hash input so feed rotation invalidates. The two schedulers see
    // identical static bytes but different RT URL sets — the manifest hash MUST differ.
    const dirA = mkdtempSync(join(tmpdir(), "ptn-scheduler-rt-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "ptn-scheduler-rt-b-"));

    try {
      const a = new GtfsScheduler({
        gtfsUrls: [`file://${tmpFeedZip}`],
        refreshIntervalHours: SAFE_REFRESH_HOURS,
        logger: noopLogger,
        scheduleTileDataDir: dirA,
        rtFeedUrls: ["https://example.invalid/rt-a.pb"],
        keepBundleCount: 1,
      });
      const b = new GtfsScheduler({
        gtfsUrls: [`file://${tmpFeedZip}`],
        refreshIntervalHours: SAFE_REFRESH_HOURS,
        logger: noopLogger,
        scheduleTileDataDir: dirB,
        rtFeedUrls: ["https://example.invalid/rt-b.pb"],
        keepBundleCount: 1,
      });

      try {
        await a.init();
        await b.init();
        // Two independent builds (separate dataDirs) — poll BOTH manifests so
        // we don't race on a shared singleton counter the first build advanced.
        await waitFor(() => existsSync(join(dirA, "manifest.json")));
        await waitFor(() => existsSync(join(dirB, "manifest.json")));

        const hashA = a.getCurrentBundleHash();
        const hashB = b.getCurrentBundleHash();
        expect(hashA).toMatch(/^[0-9a-f]{64}$/);
        expect(hashB).toMatch(/^[0-9a-f]{64}$/);
        expect(hashA).not.toBe(hashB);
      } finally {
        a.stop();
        b.stop();
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("falls back to network GTFS when the PTB bundle on disk is corrupt", async () => {
    // A present-but-broken bundle must not brick boot. The loader throws on
    // bad bytes; the scheduler must latch off PTB and load via gtfsUrls in
    // the same attempt, ending ready and healthy — not loop on the bad file.
    const badBundle = join(tmpDataDir, "bundle.ptb");
    writeFileSync(badBundle, Buffer.from("not a valid PTB bundle"));

    const errorCalls: { obj: unknown; msg: string }[] = [];
    const errLogger = {
      ...noopLogger,
      error: (obj: unknown, msg: string) => { errorCalls.push({ obj, msg }); },
    } as unknown as FastifyBaseLogger;

    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: errLogger,
      rtFeedUrls: [],
      ptnBundlePath: badBundle,
    });

    try {
      await scheduler.init();
      // No scheduleTileDataDir → no build scheduled; just drain the load's
      // deferred setImmediates.
      await drainImmediates();

      // Loaded via the network fallback: store ready, scheduler healthy.
      expect(scheduler.getStore().isReady()).toBe(true);
      expect(scheduler.lastError).toBeNull();
      // Exactly one init attempt — no retry was burned on the bad bundle.
      expect(scheduler.initAttempts).toBe(1);
      // The PTB failure was logged for the operator.
      expect(errorCalls.some((c) => /PTB sidecar load failed/.test(c.msg))).toBe(true);
      // loaderMode reflects the fallback path taken.
      expect(scheduler.loaderMode).toBe("ptb_fallback");
    } finally {
      scheduler.stop();
    }
  });

  it("takes the PTB path (no network fetch) when a valid bundle is present", async () => {
    // Write a valid PTB bundle + required sidecars to a temp dir, then
    // init a scheduler pointing at it. The store must become ready AND
    // globalThis.fetch must NOT be called (the PTB path is purely local).
    const bundlePath = join(tmpDataDir, "bundle.ptb");
    writeFileSync(bundlePath, TINY_PTB);
    writeFileSync(
      `${bundlePath}.meta.json`,
      JSON.stringify({
        schemaVersion: 1,
        producerGitSha: "tiny-fixture",
        feedStartDate: "2026-01-01",
        feeds: [
          {
            url: "file:///crates/pt-producer/tests/fixtures/tiny-gtfs.zip",
            blobSha256: "0".repeat(64),
            etag: null,
          },
        ],
      }),
    );
    writeFileSync(`${bundlePath}.shapes.json`, JSON.stringify({ schemaVersion: 1, shapes: [] }));

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const scheduler = new GtfsScheduler({
      // gtfsUrls is required but should NOT be fetched when PTB path succeeds.
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: noopLogger,
      rtFeedUrls: [],
      ptnBundlePath: bundlePath,
    });

    try {
      await scheduler.init();
      // No scheduleTileDataDir → no build scheduled; drain the deferred work.
      await drainImmediates();

      // Store ready — PTB feed was decoded successfully.
      expect(scheduler.getStore().isReady()).toBe(true);
      expect(scheduler.lastError).toBeNull();
      expect(scheduler.initAttempts).toBe(1);

      // No network I/O — the PTB path reads from disk only.
      expect(fetchSpy).not.toHaveBeenCalled();

      // loaderMode reflects the PTB path taken.
      expect(scheduler.loaderMode).toBe("ptb");
    } finally {
      scheduler.stop();
      vi.restoreAllMocks();
    }
  });

  it("refresh()'s periodic network fetch does not reuse the boot-time PTB generationDir for colors", async () => {
    // `_loaderMode` is only ever set inside loadOnce() and stays "ptb" for
    // the lifetime of the process, even though refresh() always swaps in
    // NETWORK-fetched data. Before the fix, refresh() reused the boot-time
    // `ptnBundlePath`'s directory as `generationDir`, coloring a
    // network-sourced swap from a producer generation dir totally
    // disconnected from what was just fetched. This must degrade to
    // colors-absent (matching gtfs-network mode), not silently reuse a
    // stale/unrelated generation.
    const bundlePath = join(tmpDataDir, "bundle.ptb");
    writeFileSync(bundlePath, TINY_PTB);
    writeFileSync(
      `${bundlePath}.meta.json`,
      JSON.stringify({
        schemaVersion: 1,
        producerGitSha: "tiny-fixture",
        feedStartDate: "2026-01-01",
        feeds: [
          {
            url: "file:///crates/pt-producer/tests/fixtures/tiny-gtfs.zip",
            blobSha256: "0".repeat(64),
            etag: null,
          },
        ],
      }),
    );
    writeFileSync(`${bundlePath}.shapes.json`, JSON.stringify({ schemaVersion: 1, shapes: [] }));
    // Color artifacts published alongside the PTB bundle, as a real producer
    // generation dir would have them.
    writeFileSync(
      join(tmpDataDir, "color-config.json"),
      JSON.stringify({
        modes: [{ id: "BUS", label: "Bus", parentMode: "BUS", color: "#3355ff", routeCount: 1, sampleRoutes: ["1"] }],
        palettes: {
          light: { universal: {}, deuteranopia: {}, protanopia: {}, tritanopia: {}, highContrast: {} },
          dark: { universal: {}, deuteranopia: {}, protanopia: {}, tritanopia: {}, highContrast: {} },
        },
        universalLimited: false,
      }),
    );
    writeFileSync(join(tmpDataDir, "route-styles.json"), JSON.stringify({}));
    writeFileSync(join(tmpDataDir, "label-anchors.json"), JSON.stringify({}));

    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: noopLogger,
      rtFeedUrls: [],
      ptnBundlePath: bundlePath,
    });

    try {
      await scheduler.init();
      await drainImmediates();

      expect(scheduler.loaderMode).toBe("ptb");
      expect(scheduler.getStore().getColorConfig()).not.toBeNull();

      // `refresh()` is private and only otherwise invoked by the
      // setInterval loop (hours away) — call it directly rather than
      // faking timers, which deadlocks against this scheduler's real fs/
      // network I/O.
      await (scheduler as unknown as { refresh(): Promise<void> }).refresh();
      await drainImmediates();

      // loaderMode still reports "ptb" (describes how the process booted),
      // but the swap that just ran was network-sourced — colors must go
      // absent, not stay populated from the stale boot-time generationDir.
      expect(scheduler.loaderMode).toBe("ptb");
      expect(scheduler.getStore().getColorConfig()).toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it("warns (not errors) when PT_BUNDLE_PATH is set but file is missing", async () => {
    const missingBundle = join(tmpDataDir, "does-not-exist.ptb");

    const warnCalls: { obj: unknown; msg: string }[] = [];
    const warnLogger = {
      ...noopLogger,
      warn: (obj: unknown, msg: string) => { warnCalls.push({ obj, msg }); },
    } as unknown as FastifyBaseLogger;

    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: SAFE_REFRESH_HOURS,
      logger: warnLogger,
      rtFeedUrls: [],
      ptnBundlePath: missingBundle,
    });

    try {
      await scheduler.init();
      // No scheduleTileDataDir → no build scheduled; drain the deferred work.
      await drainImmediates();

      // Fell back to network GTFS — store still ready.
      expect(scheduler.getStore().isReady()).toBe(true);
      expect(scheduler.lastError).toBeNull();

      // Operator gets a warn breadcrumb distinguishing "configured-but-missing"
      // from "not configured at all".
      expect(
        warnCalls.some(
          (c) => /PT_BUNDLE_PATH is configured but the file does not exist/.test(c.msg),
        ),
      ).toBe(true);

      // loaderMode is network, not ptnb.
      expect(scheduler.loaderMode).toBe("gtfs-network");
    } finally {
      scheduler.stop();
    }
  });
});

describe("GtfsScheduler.hydrateBundleLastSuccessGauge", () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), "ptn-hydrate-"));
    metricsRegistry.bundleLastSuccessTimestampSeconds.set(0);
  });
  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
    metricsRegistry.bundleLastSuccessTimestampSeconds.set(0);
  });

  function makeScheduler(): GtfsScheduler {
    return new GtfsScheduler({
      gtfsUrls: ["file:///dev/null"],
      refreshIntervalHours: 6,
      logger: noopLogger,
      scheduleTileDataDir: tmpDataDir,
      rtFeedUrls: [],
    });
  }

  async function gaugeValue(): Promise<number> {
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_bundle_last_success_timestamp_seconds");
    return m?.values[0]?.value ?? 0;
  }

  it("sets the gauge from manifest.generatedAt when the manifest exists", async () => {
    const generatedAtMs = 1_700_000_000_000;
    writeFileSync(
      join(tmpDataDir, "manifest.json"),
      JSON.stringify({ bundleHash: "a".repeat(64), generatedAt: generatedAtMs, tileSize: 6000 }),
    );
    makeScheduler().hydrateBundleLastSuccessGauge();
    expect(await gaugeValue()).toBe(generatedAtMs / 1000);
  });

  it("leaves the gauge at 0 when no manifest exists yet (cold start)", async () => {
    makeScheduler().hydrateBundleLastSuccessGauge();
    expect(await gaugeValue()).toBe(0);
  });

  it("leaves the gauge at 0 when manifest is malformed (corrupt JSON)", async () => {
    writeFileSync(join(tmpDataDir, "manifest.json"), "{not valid json");
    makeScheduler().hydrateBundleLastSuccessGauge();
    expect(await gaugeValue()).toBe(0);
  });

  it("leaves the gauge at 0 when scheduleTileDataDir is unset", async () => {
    const scheduler = new GtfsScheduler({
      gtfsUrls: ["file:///dev/null"],
      refreshIntervalHours: 6,
      logger: noopLogger,
      // no scheduleTileDataDir
      rtFeedUrls: [],
    });
    scheduler.hydrateBundleLastSuccessGauge();
    expect(await gaugeValue()).toBe(0);
  });

  it.each([
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
    { name: "NaN", value: Number.NaN },
    { name: "null", value: null },
    { name: "string", value: "1700000000000" },
    { name: "negative", value: -1 },
    { name: "zero", value: 0 },
  ])("rejects pathological generatedAt ($name)", async ({ value }) => {
    writeFileSync(
      join(tmpDataDir, "manifest.json"),
      JSON.stringify({ bundleHash: "a".repeat(64), generatedAt: value, tileSize: 6000 }),
    );
    makeScheduler().hydrateBundleLastSuccessGauge();
    // Negative finite values fail the `> 0` guard; non-finite/non-number
    // values fail the `Number.isFinite` guard. Either way the gauge stays at 0.
    expect(await gaugeValue()).toBe(0);
  });
});

describe("GtfsStore.resolveRouteColor / resolveRouteSubMode", () => {
  let tmpFeedZip: string;
  const prevAllowFileUrls = process.env.PT_ALLOW_FILE_URLS;

  beforeEach(() => {
    tmpFeedZip = join(tmpdir(), `ptn-store-resolver-${process.pid}-${Date.now()}.zip`);
    process.env.PT_ALLOW_FILE_URLS = "1";
    writeSyntheticGtfsZip(tmpFeedZip);
  });

  afterEach(() => {
    try { unlinkSync(tmpFeedZip); } catch { /* ignore */ }
    if (prevAllowFileUrls === undefined) {
      delete process.env.PT_ALLOW_FILE_URLS;
    } else {
      process.env.PT_ALLOW_FILE_URLS = prevAllowFileUrls;
    }
  });

  it("returns undefined for a non-PTB (network-GTFS) scheduler — no producer generation to read colors from", async () => {
    // `GtfsStore.swap()` now computes color config SYNCHRONOUSLY: when
    // `generationDir` is set (producer/PTB mode) it reads the producer's
    // published color-config.json/route-styles.json off disk; otherwise
    // (this scheduler passes only `gtfsUrls`, so `_loaderMode` stays
    // "gtfs-network" and swap()'s `generationDir` is always undefined) colors
    // stay empty PERMANENTLY. There's no more deferred setImmediate that
    // eventually populates the maps for this deployment mode — the "colors
    // absent" state is immediate and final, matching the already-first-class
    // degraded state routes/colorConfig.ts's 503, pt-serve's byte-identical
    // 503, and the frontend's colorConfigStore.ts fallback all already treat
    // as normal.
    const scheduler = new GtfsScheduler({
      gtfsUrls: [`file://${tmpFeedZip}`],
      refreshIntervalHours: 24,
      logger: noopLogger,
      rtFeedUrls: [],
    });

    try {
      await scheduler.init();
      const store = scheduler.getStore();
      // Immediately after init() — no setImmediate to wait for.
      expect(store.getColorConfig()).toBeNull();
      expect(store.resolveRouteColor("r1")).toBeUndefined();
      expect(store.resolveRouteSubMode("r1")).toBeUndefined();

      // Draining the event loop doesn't change anything — this is a
      // permanent state for this deployment mode, not a transient
      // pre-populate window.
      await drainImmediates();

      expect(store.getColorConfig()).toBeNull();
      expect(store.resolveRouteColor("r1")).toBeUndefined();
      expect(store.resolveRouteSubMode("r1")).toBeUndefined();
      // Unknown route id always undefined too.
      expect(store.resolveRouteSubMode("unknown")).toBeUndefined();
      expect(store.resolveRouteColor("unknown")).toBeUndefined();
    } finally {
      scheduler.stop();
    }
  });
});

describe("getManifestSnapshot", () => {
  let tmpDir: string;
  const prevAllowFileUrls = process.env.PT_ALLOW_FILE_URLS;

  beforeEach(() => {
    process.env.PT_ALLOW_FILE_URLS = "1";
    tmpDir = mkdtempSync(join(tmpdir(), "ptn-manifest-snap-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (prevAllowFileUrls === undefined) delete process.env.PT_ALLOW_FILE_URLS;
    else process.env.PT_ALLOW_FILE_URLS = prevAllowFileUrls;
  });

  // The snapshot accessors are pure on-disk reads — they need no init/network,
  // so construct with a throwaway file:// URL and just the tmp data dir. The
  // gtfsUrls value is never fetched in these tests.
  function makeScheduler(): GtfsScheduler {
    return new GtfsScheduler({
      gtfsUrls: ["file:///dev/null"],
      refreshIntervalHours: 24,
      logger: noopLogger,
      scheduleTileDataDir: tmpDir,
      rtFeedUrls: [],
    });
  }

  function writeManifest(bundleHash: string): void {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      bundleHash,
      generatedAt: 1,
      tileSize: 6000,
      subdivisions: {
        "1_2": {
          leaves: [
            {
              suffix: "0",
              bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
              compressedBytes: 1,
              oversized: false,
            },
          ],
        },
      },
    };
    writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify(manifest));
  }

  it("re-hashes the snapshot when manifest content changes (content-keyed)", () => {
    const scheduler = makeScheduler();
    writeManifest("HASH_A");

    const first = scheduler.getManifestSnapshot();
    expect(first).not.toBeNull();
    expect(first!.bundleHash).toBe("HASH_A");
    expect(first!.subdivisions?.["1_2"]).toBeDefined();
    expect(first!.contentEtag).toMatch(/^[0-9a-f]{32}$/);
    expect(first!.parsed.bundleHash).toBe("HASH_A");

    // getCurrentBundleHash() reads the same snapshot source.
    expect(scheduler.getCurrentBundleHash()).toBe(first!.bundleHash);

    // OVERWRITE with different content → next call re-hashes and returns HASH_B.
    // The mtime/size pre-gate must not mask a content change (content here is a
    // different length, but the re-hash is what the snapshot identity rides on).
    writeManifest("HASH_B");
    const second = scheduler.getManifestSnapshot();
    expect(second!.bundleHash).toBe("HASH_B");
    expect(second!.contentEtag).not.toBe(first!.contentEtag);
  });

  it("returns the previous-good snapshot on a transient read/parse error", () => {
    const scheduler = makeScheduler();
    writeManifest("HASH_A");
    expect(scheduler.getManifestSnapshot()!.bundleHash).toBe("HASH_A");

    // Corrupt the manifest (mid-write torn JSON) → previous-good, NOT null.
    writeFileSync(join(tmpDir, "manifest.json"), "{ not json");
    const afterCorrupt = scheduler.getManifestSnapshot();
    expect(afterCorrupt).not.toBeNull();
    expect(afterCorrupt!.bundleHash).toBe("HASH_A");
    expect(scheduler.getCurrentBundleHash()).toBe("HASH_A");

    // Remove the file (mid-rename TOCTOU) → still previous-good.
    rmSync(join(tmpDir, "manifest.json"), { force: true });
    const afterRemove = scheduler.getManifestSnapshot();
    expect(afterRemove).not.toBeNull();
    expect(afterRemove!.bundleHash).toBe("HASH_A");
    expect(scheduler.getLastKnownBundleHash()).toBe("HASH_A");
  });

  it("returns null on true cold start (no manifest ever parsed)", () => {
    const scheduler = makeScheduler();
    // No manifest.json on disk and none ever parsed.
    expect(scheduler.getManifestSnapshot()).toBeNull();
    expect(scheduler.getCurrentBundleHash()).toBeNull();
    expect(scheduler.getLastKnownBundleHash()).toBeNull();
  });
});
