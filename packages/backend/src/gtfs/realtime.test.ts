import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { parseTripUpdatesBuffer, GtfsRealtimePoller } from "./realtime.js";

// Empty protobuf FeedMessage — header-only, zero entities
const EMPTY_FEED_BYTES = new Uint8Array([
  0x0a, 0x09, 0x0a, 0x03, 0x32, 0x2e, 0x30, 0x10, 0x00, 0x18, 0x00,
]);

// The first call to parseTripUpdatesBuffer (and buildFeedBytes below) dynamically
// imports the heavy CJS `gtfs-realtime-bindings` (protobuf.js) module. That
// one-time cold module load is ~20ms warm, but under parallel-fork CI contention
// it can stall well past the default 5s per-test budget — making the otherwise
// trivial first test flake on timeout. Pay the cold load once here, in a hook with
// generous headroom and off any per-test timeout; the module is then cached for
// every test in the file, so the test bodies stay fast and deterministic.
beforeAll(async () => {
  await import("gtfs-realtime-bindings");
}, 30_000);

describe("parseTripUpdatesBuffer", () => {
  it("returns an empty map for a feed with no trip updates", async () => {
    const result = await parseTripUpdatesBuffer(EMPTY_FEED_BYTES);
    expect(result.size).toBe(0);
  });
});

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

function fakeStore() {
  const received: Map<string, { delaySeconds: number; cancelled: boolean }>[] = [];
  return {
    received,
    setRealtimeUpdates: (m: Map<string, { delaySeconds: number; cancelled: boolean }>) => {
      received.push(m);
    },
  };
}

describe("GtfsRealtimePoller construction", () => {
  it("accepts a single-URL `tripUpdatesUrl` (back-compat)", () => {
    const store = fakeStore();
    const poller = new GtfsRealtimePoller({
      tripUpdatesUrl: "http://example.test/one.pb",
      pollIntervalMs: 12_000,
      store: store as any,
      logger: noopLogger,
    });
    expect(poller.getFeedUrls()).toEqual(["http://example.test/one.pb"]);
  });

  it("accepts an array `tripUpdatesUrls`", () => {
    const store = fakeStore();
    const poller = new GtfsRealtimePoller({
      tripUpdatesUrls: ["http://example.test/a.pb", "http://example.test/b.pb"],
      pollIntervalMs: 12_000,
      store: store as any,
      logger: noopLogger,
    });
    expect(poller.getFeedUrls()).toEqual([
      "http://example.test/a.pb",
      "http://example.test/b.pb",
    ]);
  });

  it("throws when both `tripUpdatesUrl` and `tripUpdatesUrls` are supplied", () => {
    expect(() => new GtfsRealtimePoller({
      tripUpdatesUrl: "http://example.test/a.pb",
      tripUpdatesUrls: ["http://example.test/b.pb"],
      pollIntervalMs: 12_000,
      store: fakeStore() as any,
      logger: noopLogger,
    } as any)).toThrow(/either.+tripUpdatesUrl.+tripUpdatesUrls/i);
  });

  it("throws when neither is supplied", () => {
    expect(() => new GtfsRealtimePoller({
      pollIntervalMs: 12_000,
      store: fakeStore() as any,
      logger: noopLogger,
    } as any)).toThrow(/must provide.+tripUpdatesUrl/i);
  });

  it("throws when `tripUpdatesUrl` is an empty string", () => {
    expect(() => new GtfsRealtimePoller({
      tripUpdatesUrl: "",
      pollIntervalMs: 12_000,
      store: fakeStore() as any,
      logger: noopLogger,
    })).toThrow(/must be a non-empty string/i);
  });

  it("throws when `tripUpdatesUrls` is an empty array", () => {
    expect(() => new GtfsRealtimePoller({
      tripUpdatesUrls: [],
      pollIntervalMs: 12_000,
      store: fakeStore() as any,
      logger: noopLogger,
    })).toThrow(/non-empty array/i);
  });

  it("throws when `tripUpdatesUrls` contains an empty string", () => {
    expect(() => new GtfsRealtimePoller({
      tripUpdatesUrls: ["http://a.test/a.pb", ""],
      pollIntervalMs: 12_000,
      store: fakeStore() as any,
      logger: noopLogger,
    })).toThrow(/must not contain empty strings/i);
  });

  it("throws both-supplied error when tripUpdatesUrl is empty-string and tripUpdatesUrls is populated", () => {
    expect(() => new GtfsRealtimePoller({
      tripUpdatesUrl: "",
      tripUpdatesUrls: ["http://a.test/a.pb"],
      pollIntervalMs: 12_000,
      store: fakeStore() as any,
      logger: noopLogger,
    } as any)).toThrow(/either.+tripUpdatesUrl.+tripUpdatesUrls/i);
  });
});

describe("multi-feed polling", () => {
  it("merges updates from multiple feeds into a single map", async () => {
    const store = fakeStore();
    const originalFetch = globalThis.fetch;
    const feedA = await buildFeedBytes([{ tripId: "trip-A", delay: 60 }]);
    const feedB = await buildFeedBytes([{ tripId: "trip-B", delay: -30 }]);
    globalThis.fetch = async (url: any) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        (String(url).endsWith("a.pb") ? feedA : feedB).buffer,
    }) as any;

    const poller = new GtfsRealtimePoller({
      tripUpdatesUrls: ["http://example.test/a.pb", "http://example.test/b.pb"],
      pollIntervalMs: 60_000,
      store: store as any,
      logger: noopLogger,
    });
    await (poller as any).poll();
    globalThis.fetch = originalFetch;

    expect(store.received).toHaveLength(1);
    const merged = store.received[0];
    expect(merged.get("trip-A")?.delaySeconds).toBe(60);
    expect(merged.get("trip-B")?.delaySeconds).toBe(-30);
  });

  it("keeps surviving feed's updates when another feed fails", async () => {
    const store = fakeStore();
    const originalFetch = globalThis.fetch;
    const feedA = await buildFeedBytes([{ tripId: "trip-A", delay: 60 }]);
    globalThis.fetch = async (url: any) =>
      String(url).endsWith("a.pb")
        ? ({ ok: true, status: 200, arrayBuffer: async () => feedA.buffer } as any)
        : ({ ok: false, status: 503 } as any);

    const poller = new GtfsRealtimePoller({
      tripUpdatesUrls: ["http://example.test/a.pb", "http://example.test/b.pb"],
      pollIntervalMs: 60_000,
      store: store as any,
      logger: noopLogger,
    });
    await (poller as any).poll();
    globalThis.fetch = originalFetch;

    const merged = store.received[0];
    expect(merged.get("trip-A")?.delaySeconds).toBe(60);
    // trip-B absent; no exception thrown
  });

  it("reports per-feed health via getFeedHealth()", async () => {
    const store = fakeStore();
    const originalFetch = globalThis.fetch;
    const feedA = await buildFeedBytes([{ tripId: "trip-A", delay: 0 }]);
    globalThis.fetch = async (url: any) =>
      String(url).endsWith("a.pb")
        ? ({ ok: true, status: 200, arrayBuffer: async () => feedA.buffer } as any)
        : ({ ok: false, status: 503 } as any);

    const poller = new GtfsRealtimePoller({
      tripUpdatesUrls: ["http://example.test/a.pb", "http://example.test/b.pb"],
      pollIntervalMs: 60_000,
      store: store as any,
      logger: noopLogger,
    });
    await (poller as any).poll();
    globalThis.fetch = originalFetch;

    const health = poller.getFeedHealth();
    expect(health).toHaveLength(2);
    const a = health.find((h) => h.url.endsWith("a.pb"))!;
    const b = health.find((h) => h.url.endsWith("b.pb"))!;
    expect(a.status).toBe("ok");
    expect(b.status).toBe("failed");
    expect(typeof a.lastFetchedAt).toBe("number");
  });
});

describe("per-feed fetch timeout", () => {
  it("marks a feed failed when fetch exceeds FEED_FETCH_TIMEOUT_MS", async () => {
    const store = fakeStore();
    const originalFetch = globalThis.fetch;

    // Mock fetch: hang forever unless aborted. Reject with AbortError when
    // signal is aborted, matching real fetch semantics.
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted") as Error & { name: string };
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        }
        // Never resolve — simulate a hanging upstream.
      })) as typeof fetch;

    const poller = new GtfsRealtimePoller({
      tripUpdatesUrls: ["http://hanging.test/a.pb"],
      pollIntervalMs: 60_000,
      store: store as any,
      logger: noopLogger,
    });

    // Use fake timers to advance past the timeout without waiting in real time.
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    const pollPromise = (poller as any).poll();
    await vi.advanceTimersByTimeAsync(15_000);
    await pollPromise;
    vi.useRealTimers();

    globalThis.fetch = originalFetch;

    const health = poller.getFeedHealth();
    expect(health[0].status).toBe("failed");
    expect(health[0].lastError).toMatch(/abort/i);
  }, 10_000);
});

// Helper: build a minimal GTFS-RT FeedMessage with trip-update entities.
// Async because it dynamic-imports the CJS bindings the same way realtime.ts does.
async function buildFeedBytes(
  entities: { tripId: string; delay: number }[],
): Promise<Uint8Array> {
  const GtfsRealtimeBindings = await import("gtfs-realtime-bindings");
  const { transit_realtime } =
    (GtfsRealtimeBindings as any).default ?? GtfsRealtimeBindings;
  const feed = transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: 0,
      timestamp: 0,
    },
    entity: entities.map((e, i) => ({
      id: `e${i}`,
      tripUpdate: {
        trip: { tripId: e.tripId },
        stopTimeUpdate: [{ departure: { delay: e.delay } }],
      },
    })),
  });
  const encoded = transit_realtime.FeedMessage.encode(feed).finish();
  // Copy into a fresh Uint8Array so .buffer is exactly the encoded bytes with no extra offset/capacity.
  return new Uint8Array(encoded);
}
