import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  nearestStopCentroid,
  useStopPreloader,
} from "../../src/hooks/useStopPreloader.ts";
import {CityDataContext, useCityDataStore} from "../../src/services/cityData.ts";
import type { StopWithLines } from "@pt/shared";

const upsertStopsMock = vi.fn().mockResolvedValue(undefined);
const overlayBundleStopsMock = vi.fn().mockResolvedValue(undefined);
const reportErrorMock = vi.fn();
let cachedStops: StopWithLines[] = [];
let activeCityId = "vilnius";

vi.mock("../../src/services/api.ts", () => ({
  api: {
    getNearbyStops: vi.fn().mockResolvedValue({ data: [] }),
    getAllStops: vi.fn().mockResolvedValue({ data: [] }),
  },
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "HttpError";
      this.status = status;
    }
  },
}));

vi.mock("../../src/services/errorReporter.ts", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

vi.mock("../../src/stores/stopStore.ts", () => ({
  useStopStore: Object.assign(
    (selector: any) => selector({ stops: cachedStops, hydrated: true }),
    {
      getState: () => ({
        upsertStops: upsertStopsMock,
        overlayBundleStops: overlayBundleStopsMock,
        hydrate: vi.fn(),
        hydrated: true,
        stops: cachedStops,
      }),
    }
  ),
}));

// useStopPreloader no longer depends on settings — urban-mode filtering
// moved to useVisibleStops (view-time). Leaving the mock block out.

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: Object.assign(
    (selector: any) => selector({ activeCity: { id: activeCityId, name: activeCityId } }),
    { getState: () => ({ activeCity: { id: activeCityId, name: activeCityId } }) },
  ),
}));

import { api, HttpError } from "../../src/services/api.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

describe("useStopPreloader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeCityId = "vilnius";
    useCityDataStore.setState({active: null});
    upsertStopsMock.mockResolvedValue(undefined);
    usePrivacyStore.getState().reset();
    resetFlows();
    allowFlow("operator.nearby-stop-centroid");
    cachedStops = [
      {
        id: "public-centroid",
        name: "Public centroid",
        location: { lat: 54.68, lon: 25.28 },
        lines: [],
      },
    ];
  });

  it("paints an arriving local catalog while the API request is stalled", async () => {
    cachedStops = [];
    vi.mocked(api.getAllStops).mockReturnValueOnce(new Promise(() => {}));
    const {unmount} = renderHook(() => useStopPreloader(null));
    expect(overlayBundleStopsMock).not.toHaveBeenCalled();
    const context = new CityDataContext({
      meta: {cityId: "vilnius", generatedAt: "2026-11-07", cityTzIana: "UTC"},
      stops: [], routes: [], calendar: [],
    }, {id: "current", cityId: "vilnius", generationId: "local", etag: "local", generatedAt: "2026-11-07", lastSynced: 1});
    act(() => { useCityDataStore.setState({active: context}); });
    await waitFor(() => expect(overlayBundleStopsMock).toHaveBeenCalledTimes(1));
    expect(upsertStopsMock).not.toHaveBeenCalled();
    unmount();
    useCityDataStore.setState({active: null});
  });

  it("reloads A after B paints but its stop persistence is still pending", async () => {
    vi.mocked(api.getAllStops).mockResolvedValue({data: [{
      id: "reused", name: "Stop", location: {lat: 54.68, lon: 25.28},
    }]} as Awaited<ReturnType<typeof api.getAllStops>>);
    let finishB!: () => void;
    upsertStopsMock.mockImplementation((_stops, options) => options.cityId === "krakow"
      ? new Promise<void>(resolve => { finishB = resolve; }) : Promise.resolve());
    const {rerender} = renderHook(() => useStopPreloader(null));
    await waitFor(() => expect(upsertStopsMock).toHaveBeenCalledTimes(1));
    // Let A finish marking its successful load before visiting B.
    await Promise.resolve();
    activeCityId = "krakow";
    rerender();
    await waitFor(() => expect(upsertStopsMock).toHaveBeenCalledTimes(2));
    activeCityId = "vilnius";
    rerender();
    await waitFor(() => expect(api.getAllStops).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(upsertStopsMock).toHaveBeenCalledTimes(3));
    finishB();
    await Promise.resolve();
    expect(upsertStopsMock.mock.calls[2][1].cityId).toBe("vilnius");
  });

  it("calls getNearbyStops with the nearest public centroid, never GPS", async () => {
    (api.getNearbyStops as any).mockResolvedValue({ data: [
      { id: "s1", name: "Stop 1", location: { lat: 54.68, lon: 25.28 } },
    ]});

    renderHook(() =>
      useStopPreloader({ lat: 54.68123, lon: 25.28456 }, 1)
    );

    await waitFor(() => {
      expect(api.getNearbyStops).toHaveBeenCalledWith(54.68, 25.28, 1000);
    });
  });

  it("selects the nearest cached stop centroid locally", () => {
    const nearest = nearestStopCentroid(
      { lat: 54.681, lon: 25.281 },
      [
        ...cachedStops,
        {
          id: "farther",
          name: "Farther",
          location: { lat: 55, lon: 26 },
          lines: [],
        },
      ],
    );
    expect(nearest).toEqual({ lat: 54.68, lon: 25.28 });
  });

  it("never queries the server for passive tracking updates", async () => {
    const { rerender } = renderHook(({ location }) => useStopPreloader(location, 0), {
      initialProps: { location: { lat: 54.6801, lon: 25.2801 } },
    });
    rerender({ location: { lat: 54.6802, lon: 25.2802 } });
    await waitFor(() => expect(api.getAllStops).toHaveBeenCalled());
    expect(api.getNearbyStops).not.toHaveBeenCalled();
  });

  it("serves each explicit request once, ignoring later passive updates", async () => {
    const { rerender } = renderHook(
      ({ location, requestId }) => useStopPreloader(location, requestId),
      { initialProps: { location: null as { lat: number; lon: number } | null, requestId: 1 } },
    );
    expect(api.getNearbyStops).not.toHaveBeenCalled();
    // The fix arrives after the request.
    rerender({ location: { lat: 54.6801, lon: 25.2801 }, requestId: 1 });
    await waitFor(() => expect(api.getNearbyStops).toHaveBeenCalledTimes(1));
    rerender({ location: { lat: 54.6802, lon: 25.2802 }, requestId: 1 });
    rerender({ location: { lat: 54.6803, lon: 25.2803 }, requestId: 1 });
    expect(api.getNearbyStops).toHaveBeenCalledTimes(1);
    rerender({ location: { lat: 54.6803, lon: 25.2803 }, requestId: 2 });
    await waitFor(() => expect(api.getNearbyStops).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["unset", () => resetFlows()],
    ["denied", () => denyFlow("operator.nearby-stop-centroid")],
  ])("skips the nearby endpoint while the lookup is %s", async (_name, apply) => {
    apply();
    renderHook(() => useStopPreloader({ lat: 54.68123, lon: 25.28456 }, 1));
    await Promise.resolve();
    expect(api.getNearbyStops).not.toHaveBeenCalled();
  });

  it("asks again after the lookup is allowed", async () => {
    resetFlows();
    const { rerender } = renderHook(({ requestId }) =>
      useStopPreloader({ lat: 54.68123, lon: 25.28456 }, requestId), {
      initialProps: { requestId: 1 },
    });
    await Promise.resolve();
    expect(api.getNearbyStops).not.toHaveBeenCalled();
    allowFlow("operator.nearby-stop-centroid");
    rerender({ requestId: 2 });
    await waitFor(() => expect(api.getNearbyStops).toHaveBeenCalledTimes(1));
  });

  it("skips the nearby endpoint on a cold cache", async () => {
    cachedStops = [];
    renderHook(() => useStopPreloader({ lat: 54.68123, lon: 25.28456 }, 1));
    await Promise.resolve();
    expect(api.getNearbyStops).not.toHaveBeenCalled();
  });

  it("re-reads the decision before a retry after it is revoked", async () => {
    vi.useFakeTimers();
    (api.getNearbyStops as any).mockRejectedValue(new Error("temporary"));
    renderHook(() => useStopPreloader({ lat: 54.68123, lon: 25.28456 }, 1));

    await vi.advanceTimersByTimeAsync(0);
    expect(api.getNearbyStops).toHaveBeenCalledTimes(1);
    denyFlow("operator.nearby-stop-centroid");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.getNearbyStops).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("calls getAllStops regardless of location", async () => {
    (api.getAllStops as any).mockResolvedValue({ data: [
      { id: "s2", name: "Stop 2", location: { lat: 54.69, lon: 25.29 } },
    ]});

    renderHook(() =>
      useStopPreloader(null)
    );

    await waitFor(() => {
      expect(api.getAllStops).toHaveBeenCalled();
    });
  });

  it("does nothing with getNearbyStops when location is null", () => {
    renderHook(() => useStopPreloader(null));
    expect(api.getNearbyStops).not.toHaveBeenCalled();
  });

  it("calls getAllStops with no arguments (filter moved to view-time)", async () => {
    (api.getAllStops as any).mockResolvedValue({ data: [
      { id: "s1", name: "Stop 1", location: { lat: 54.68, lon: 25.28 } },
    ]});

    renderHook(() => useStopPreloader(null));

    await waitFor(() => {
      expect(api.getAllStops).toHaveBeenCalledWith();
    });
  });

  it("retries getAllStops with backoff after a transient failure", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any)
      .mockRejectedValueOnce(new Error("network stall"))
      .mockResolvedValueOnce({
        data: [{ id: "s1", name: "Stop 1", location: { lat: 0, lon: 0 } }],
      });

    renderHook(() => useStopPreloader(null));

    // Drain microtasks so the first attempt's rejection threads through
    // its catch block (scheduling the retry timer). `advanceTimersByTimeAsync(0)`
    // drains pending microtasks under fake timers; `vi.waitFor` would hang
    // because its internal poll uses setTimeout, which is mocked.
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getAllStops).toHaveBeenCalledTimes(1);

    // Advance past the first backoff (1000ms) so the retry fires and resolves.
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.getAllStops).toHaveBeenCalledTimes(2);
    expect(upsertStopsMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("reports once via reportError after the final retry attempt fails", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any).mockRejectedValue(new Error("still down"));

    renderHook(() => useStopPreloader(null));

    // Drain the initial attempt + the 2 retry delays (1s + 4s = 5s total).
    // Advance 30s for headroom; advanceTimersByTimeAsync drains nested timers.
    await vi.advanceTimersByTimeAsync(30_000);

    // Three total attempts (initial + RETRY_BACKOFFS_MS.length retries).
    expect(api.getAllStops).toHaveBeenCalledTimes(3);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [errArg, extraArg] = reportErrorMock.mock.calls[0];
    expect(errArg).toBeInstanceOf(Error);
    expect((errArg as Error).message).toBe("still down");
    expect(extraArg).toMatchObject({
      context: {
        where: "useStopPreloader.loadAll",
        cityId: "vilnius",
      },
    });

    vi.useRealTimers();
  });

  // The map's only other stop source is the PTB bundle already on the device
  // (db.gtfsStops), which is what /stops/all is built from server-side. When
  // the server is unreachable there is no reason to leave the map blank.
  it("falls back to the on-device bundle after the last attempt fails", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any).mockRejectedValue(new Error("still down"));

    renderHook(() => useStopPreloader(null));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.getAllStops).toHaveBeenCalledTimes(3);
    expect(overlayBundleStopsMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("does not touch the bundle fallback while retries are still pending", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any)
      .mockRejectedValueOnce(new Error("network stall"))
      .mockResolvedValueOnce({
        data: [{ id: "s1", name: "Stop 1", location: { lat: 0, lon: 0 } }],
      });

    renderHook(() => useStopPreloader(null));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(upsertStopsMock).toHaveBeenCalledTimes(1);
    expect(overlayBundleStopsMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("falls back to the on-device bundle when the rate limiter short-circuits", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any).mockRejectedValue(new HttpError(429, "Too Many Requests"));

    renderHook(() => useStopPreloader(null));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.getAllStops).toHaveBeenCalledTimes(1);
    expect(overlayBundleStopsMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // Cache-poisoning self-heal. NetworkFirst stops handler in the SW
  // (vite.config.ts) can hand back a stale `{ data: [] }` cached during an
  // earlier moment of badness; without treating empty as a failure, the
  // preloader silently marks loadAll as "done" and the map never refills
  // until the user reinstalls the PWA (see fix/pwa-stops-cache-poison).
  it("retries when getAllStops returns empty data (poisoned SW cache)", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any)
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: "s1", name: "Stop 1", location: { lat: 0, lon: 0 } }],
      });

    renderHook(() => useStopPreloader(null));

    await vi.advanceTimersByTimeAsync(0);
    expect(api.getAllStops).toHaveBeenCalledTimes(1);
    expect(upsertStopsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(api.getAllStops).toHaveBeenCalledTimes(2);
    expect(upsertStopsMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // The empty-data path goes through a different `throw` site than network
  // rejection (line 88 of useStopPreloader.ts), so it needs its own end-to-end
  // assertion that final-attempt failure surfaces to reportError. Without
  // this, a regression that silently re-treated empty as success on the last
  // attempt would still be caught by the (existing) network-rejection retry
  // test but go undetected for the cache-poisoned scenario.
  it("reports once when all three attempts return empty data", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any).mockResolvedValue({ data: [] });

    renderHook(() => useStopPreloader(null));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.getAllStops).toHaveBeenCalledTimes(3);
    expect(upsertStopsMock).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [errArg] = reportErrorMock.mock.calls[0];
    expect((errArg as Error).message).toBe("/stops/all returned empty data");

    vi.useRealTimers();
  });

  // 429 short-circuits the retry chain — rate-limit windows are minute-scale
  // on the backend so a retry within the backoff window guarantees another
  // 429. Worse, on shared-NAT networks a misbehaving user can burn the whole
  // subnet's budget if every session triple-attempts on rate-limit hits.
  it("short-circuits the retry chain on HTTP 429", async () => {
    vi.useFakeTimers();
    const { HttpError } = await import("../../src/services/api.ts");
    (api.getAllStops as any).mockRejectedValue(new HttpError(429, "rate limited"));

    renderHook(() => useStopPreloader(null));

    await vi.advanceTimersByTimeAsync(30_000);

    // First attempt fires, hits 429, and stops — no second/third attempt.
    expect(api.getAllStops).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, ctx] = reportErrorMock.mock.calls[0];
    expect(ctx).toMatchObject({
      context: { where: "useStopPreloader.loadAll.rateLimited" },
    });

    vi.useRealTimers();
  });

  // Cache-bypass on retry. If attempt 1 was served from the SW's
  // `api-stops-cache-v1`, attempt 2 hitting the identical URL gets the same
  // poisoned response. Passing `bypassCache:true` lets api.getAllStops
  // append a cache-buster so the SW cache key misses.
  it("passes bypassCache:true on retry attempts (defeats SW cache lookup)", async () => {
    vi.useFakeTimers();
    (api.getAllStops as any)
      .mockRejectedValueOnce(new Error("stall"))
      .mockResolvedValueOnce({
        data: [{ id: "s1", name: "Stop 1", location: { lat: 0, lon: 0 } }],
      });

    renderHook(() => useStopPreloader(null));

    await vi.advanceTimersByTimeAsync(0);
    expect(api.getAllStops).toHaveBeenNthCalledWith(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(api.getAllStops).toHaveBeenNthCalledWith(2, { bypassCache: true });

    vi.useRealTimers();
  });

  // pt-serve returns 503 during its ~15 s self-reload window.
  // A single transient 503 on /stops/nearby must be retried with bounded
  // backoff and eventually surface the nearby stops.
  it("retries getNearbyStops once after a transient 503", async () => {
    vi.useFakeTimers();
    const { HttpError } = await import("../../src/services/api.ts");
    const stop = { id: "n1", name: "Near 1", location: { lat: 54.68, lon: 25.28 } };
    (api.getNearbyStops as any)
      .mockRejectedValueOnce(new HttpError(503, "pt-serve reloading"))
      .mockResolvedValueOnce({ data: [stop] });

    renderHook(() => useStopPreloader({ lat: 54.68, lon: 25.28 }, 1));

    // Drain microtasks so the first attempt's 503 rejection propagates through
    // the catch block and the retry timer is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getNearbyStops).toHaveBeenCalledTimes(1);
    // upsertStops must NOT have been called yet (first attempt failed).
    expect(upsertStopsMock).not.toHaveBeenCalled();

    // Advance past the first backoff (1000 ms) so the retry fires and resolves.
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.getNearbyStops).toHaveBeenCalledTimes(2);
    expect(upsertStopsMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // When /stops/nearby keeps returning 503 through all retry attempts, the
  // hook must degrade gracefully: no throw, no state blank, no crash.
  // The nearby store is left as-is (empty on a cold load). The /stops/all
  // path must remain independent — /nearby exhausting its retries must NOT
  // trigger an error report for the /all path.
  it("degrades gracefully when getNearbyStops returns persistent 503", async () => {
    vi.useFakeTimers();
    const { HttpError } = await import("../../src/services/api.ts");
    (api.getNearbyStops as any).mockRejectedValue(new HttpError(503, "pt-serve down"));
    // Keep /stops/all healthy so it doesn't produce its own reportError call,
    // which would make the reportErrorMock assertion ambiguous.
    (api.getAllStops as any).mockResolvedValue({
      data: [{ id: "s1", name: "Stop 1", location: { lat: 54.68, lon: 25.28 } }],
    });

    renderHook(() => useStopPreloader({ lat: 54.68, lon: 25.28 }, 1));

    // Advance well past all retry backoffs (1 s + 4 s = 5 s total).
    await vi.advanceTimersByTimeAsync(30_000);

    // All retry attempts exhausted.
    expect(api.getNearbyStops).toHaveBeenCalledTimes(3);
    // Must NOT report to errorReporter — nearby is best-effort, persistent
    // 503 is an expected degraded-mode scenario during pt-serve reload.
    expect(reportErrorMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
