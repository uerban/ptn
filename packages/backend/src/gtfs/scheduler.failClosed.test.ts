import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyBaseLogger } from "fastify";

// vi.mock factories are hoisted above all imports/const declarations, so the
// mock fns they reference must be created with vi.hoisted() (also hoisted) —
// a plain `const` would be in the temporal dead zone when the factory runs.
const { loadFromPtbMock, loadGtfsMock } = vi.hoisted(() => ({
  // loadFromPtb always throws — simulating a corrupt/incompatible bundle that
  // is present on disk. The scheduler's loadOnce() catch then falls through to
  // the network-load path, which is the behaviour under test.
  loadFromPtbMock: vi.fn(() => {
    throw new Error("simulated corrupt bundle");
  }),
  // loadGtfs is the network path. In the fail-closed scenario it must NEVER be
  // invoked with an empty URL set — ideally never at all. If the guard
  // regresses and it is called with [], we still must not let it "succeed" and
  // come up on the wrong feed — so any call throws.
  // Typed params (matching loadGtfs's leading args) so `mock.calls[i][0]` is a
  // `string[]` for the URL-array assertions below — an arg-less `vi.fn` would
  // infer a zero-length tuple and reject the indexing.
  loadGtfsMock: vi.fn(
    async (_urls: string[], _etags?: Map<string, string>, _minTripsPerRoute?: number) => {
      throw new Error("loadGtfs should not be reached in the fail-closed scenario");
    },
  ),
}));

vi.mock("./loadFromPtb.js", () => ({
  loadFromPtb: loadFromPtbMock,
}));

// Preserve the module's other exports (loadFromPtb.ts imports
// `shapesEnabled`/`LoadResult` from here) and only stub the function.
vi.mock("./loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loader.js")>();
  return { ...actual, loadGtfs: loadGtfsMock };
});

// Import AFTER vi.mock calls (vitest hoists vi.mock above imports, so this is
// safe — the scheduler module graph sees the mocked loadFromPtb/loadGtfs).
import { GtfsScheduler } from "./scheduler.js";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  level: "info" as const, silent: () => {},
  child: () => noopLogger,
} as unknown as FastifyBaseLogger;

describe("GtfsScheduler fail-closed: PTB unavailable + no GTFS_STATIC_URL", () => {
  let tmpDir: string;
  let ptbPath: string;

  beforeEach(() => {
    loadFromPtbMock.mockClear();
    loadGtfsMock.mockClear();
    tmpDir = mkdtempSync(join(tmpdir(), "ptn-failclosed-"));
    // A real, existing file so the scheduler's `existsSync(ptnBundlePath)`
    // check is true and it takes the PTB branch (which then throws via the
    // mock). Contents are irrelevant — loadFromPtb is mocked.
    ptbPath = join(tmpDir, "bundle.ptb");
    writeFileSync(ptbPath, Buffer.from("not a real ptb"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("constructs in PTB mode even with an empty gtfsUrls (must not crash boot)", () => {
    // index.ts passes gtfsUrls: [] in PTB mode when GTFS_STATIC_URL is empty
    // (resolveGtfsStaticUrls). The scheduler must be constructible so the
    // server can come up and fail closed at /ready — not crash at construction.
    expect(
      () =>
        new GtfsScheduler({
          gtfsUrls: [],
          refreshIntervalHours: 24,
          logger: noopLogger,
          rtFeedUrls: [],
          ptnBundlePath: ptbPath,
        }),
    ).not.toThrow();
  });

  it("fails closed: PTB load throws + empty gtfsUrls => never loads via network, never enters ptb_fallback", async () => {
    const scheduler = new GtfsScheduler({
      gtfsUrls: [],
      refreshIntervalHours: 24,
      logger: noopLogger,
      rtFeedUrls: [],
      ptnBundlePath: ptbPath,
    });

    // init() catches loadOnce throws (server stays up, schedules a retry), so
    // it resolves rather than rejecting. The fail-closed proof is in the state
    // after the attempt, not in init() throwing.
    await scheduler.init();
    scheduler.stop();

    // The PTB branch was taken and threw.
    expect(loadFromPtbMock).toHaveBeenCalledTimes(1);

    // The definitive fail-closed proof: loadGtfs must never have been called at
    // all in this scenario — so the "download an unrelated default feed" path
    // is unreachable. (Belt-and-braces: had it been called, it must never be
    // with an empty URL array.)
    expect(loadGtfsMock).not.toHaveBeenCalled();
    for (const call of loadGtfsMock.mock.calls) {
      expect(call[0].length).toBeGreaterThan(0);
    }

    // loaderMode must NOT have advanced to "ptb_fallback": that value is only
    // assigned AFTER a successful network load in loadOnce's catch block, so
    // its absence proves loadViaNetwork threw before the fallback "succeeded".
    //
    // Note we deliberately do NOT assert `!== "gtfs-network"`: that string is
    // also the field's *initial default* (loaderMode is documented as the path
    // of the most recent SUCCESSFUL load — undefined before any success). On a
    // fresh scheduler that only ever failed, it sits at that default, so the
    // value is ambiguous here. `loadGtfs` never being called + store not-ready
    // is the unambiguous signal that no network load happened.
    expect(scheduler.loaderMode).not.toBe("ptb_fallback");

    // The store stays not-ready (fail closed => /ready stays not-ready).
    expect(scheduler.getStore().isReady()).toBe(false);
    // An error was recorded for the failed attempt.
    expect(scheduler.lastError).not.toBeNull();
  });

  it("still loads via network when a real GTFS_STATIC_URL IS configured (fallback not over-broad)", async () => {
    // Guard rail: the empty-URL refusal must not break the legitimate
    // ptb_fallback path. With a non-empty gtfsUrls, loadGtfs is reached.
    // (Our loadGtfs mock throws, so this stays not-ready too — but the proof
    // here is simply that loadGtfs WAS reached with a non-empty URL set.)
    const scheduler = new GtfsScheduler({
      gtfsUrls: ["https://example.test/feed.zip"],
      refreshIntervalHours: 24,
      logger: noopLogger,
      rtFeedUrls: [],
      ptnBundlePath: ptbPath,
    });

    await scheduler.init();
    scheduler.stop();

    expect(loadFromPtbMock).toHaveBeenCalledTimes(1);
    expect(loadGtfsMock).toHaveBeenCalledTimes(1);
    expect(loadGtfsMock.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it("refresh() with empty gtfsUrls skips quietly — no error recorded on a healthy PTB-only node", async () => {
    // After a successful PTB boot with no GTFS_STATIC_URL configured, the
    // periodic refresh loop must not throw the fail-closed error every interval
    // (which would error-log an otherwise-healthy node). It should skip the
    // network refresh gracefully. We invoke the private refresh() directly (it's
    // what the interval timer calls).
    const scheduler = new GtfsScheduler({
      gtfsUrls: [],
      refreshIntervalHours: 24,
      logger: noopLogger,
      rtFeedUrls: [],
      ptnBundlePath: ptbPath,
    });

    await (scheduler as unknown as { refresh(): Promise<void> }).refresh();
    scheduler.stop();

    // No network load attempted, and crucially no error recorded — refresh
    // skipped, it did not fail. (Before the guard, refresh routed through
    // loadViaNetwork([]) which threw, setting lastError on a healthy node.)
    expect(loadGtfsMock).not.toHaveBeenCalled();
    expect(scheduler.lastError).toBeNull();
  });
});
