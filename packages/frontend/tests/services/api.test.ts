import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: {
    getState: () => ({ getApiUrl: () => "/api/vilnius" }),
  },
}));

import { api, HttpError } from "../../src/services/api.ts";
import { serverTime } from "../../src/services/serverTime.ts";
import type { PlanRequest, RaptorItinerary } from "@pt/shared";

const ORIGINAL_FETCH = globalThis.fetch;

const FRESH_DATE = new Date().toUTCString();

function mockJsonResponse(body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", Date: FRESH_DATE },
    }),
  ) as unknown as typeof fetch;
}

describe("api.fetchJson — server-time sync is opt-out for every endpoint", () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateSpy = vi.spyOn(serverTime, "update");
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    updateSpy.mockRestore();
  });

  it("does not call serverTime.update on getAllStops responses", async () => {
    // /stops/all is the workbox NetworkFirst rule with the longest cache TTL
    // (24h). Reading Date from a cached-fallback response was the
    // production source of large negative offsets. fetchJson must not
    // ingest Date from this path.
    globalThis.fetch = mockJsonResponse({ data: [] });

    await api.getAllStops();

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not call serverTime.update on getDepartures responses", async () => {
    globalThis.fetch = mockJsonResponse({ data: [] });

    await api.getDepartures("stop1");

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not call serverTime.update on getNearbyStops responses", async () => {
    globalThis.fetch = mockJsonResponse({ data: [] });

    await api.getNearbyStops(54.68, 25.28);

    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("api.getAllStops — cache-bypass and HTTP status", () => {
  const ORIG = globalThis.fetch;
  afterEach(() => { globalThis.fetch = ORIG; });

  it("appends a _r cache-buster to the URL when bypassCache is true", async () => {
    // Capture the actual URL fetch sees so we can assert the cache-buster
    // landed in the query string — without it, the SW NetworkFirst lookup
    // would key on the same canonical URL as the (possibly poisoned) prior
    // entry and never hit the network.
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      seenUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await api.getAllStops({ bypassCache: true });

    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toMatch(/[?&]_r=\d+/);
  });

  it("does NOT append _r when bypassCache is not passed", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      seenUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await api.getAllStops();

    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).not.toMatch(/_r=/);
  });

  it("throws HttpError carrying the status code on non-OK responses", async () => {
    // Status-aware exception lets callers (e.g. useStopPreloader's 429
    // short-circuit) branch without parsing message strings.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(api.getAllStops()).rejects.toMatchObject({
      name: "HttpError",
      status: 429,
    });
  });

  it("HttpError is an Error subclass with the friendly message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Service Unavailable", { status: 503 }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try { await api.getAllStops(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as HttpError).status).toBe(503);
    expect((caught as Error).message).toContain("Transit data is still loading");
  });
});

describe("api.plan — POST /plan to pt-serve", () => {
  const ORIG = globalThis.fetch;
  afterEach(() => { globalThis.fetch = ORIG; });

  const REQ: PlanRequest = {
    entryStops: [{ stopId: "A", walkSecs: 0 }],
    exitStops: [{ stopId: "B", walkSecs: 30 }],
    departureSecs: 32400,
    date: "20260623",
    maxRounds: 4,
    mobilityProfile: "default",
  };

  function captureFetch(
    impl: () => Response,
  ): { calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return impl();
    }) as unknown as typeof fetch;
    return { calls };
  }

  const ITINERARY: RaptorItinerary = {
    legs: [
      {
        type: "transit",
        fromStopId: "A",
        toStopId: "B",
        departSecs: 32400,
        arriveSecs: 33000,
        routeId: "R1",
        tripId: "T1",
        boardStopIdx: 0,
        alightStopIdx: 1,
      },
    ],
    boardSecs: 32400,
    alightSecs: 33000,
    transfers: 0,
  };

  it("POSTs to a URL ending /plan with method POST, JSON content-type, and a JSON-stringified body", async () => {
    const { calls } = captureFetch(() =>
      new Response(JSON.stringify([ITINERARY]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await api.plan(REQ);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toMatch(/\/api\/vilnius\/plan$/);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify(REQ));
  });

  it("parses a 200 RaptorItinerary[] body", async () => {
    captureFetch(() =>
      new Response(JSON.stringify([ITINERARY]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await api.plan(REQ);

    expect(result).toEqual([ITINERARY]);
  });

  it("parses a 200 [] body to []", async () => {
    captureFetch(() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await api.plan(REQ);

    expect(result).toEqual([]);
  });

  it("throws HttpError on a 400 (malformed request / unknown stop)", async () => {
    captureFetch(() =>
      new Response(JSON.stringify({ error: { message: "unknown stopId" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(api.plan(REQ)).rejects.toMatchObject({
      name: "HttpError",
      status: 400,
    });
  });

  it("throws HttpError on a 500 (engine error)", async () => {
    captureFetch(() =>
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(api.plan(REQ)).rejects.toMatchObject({
      name: "HttpError",
      status: 500,
    });
  });

  it("throws on a network/fetch rejection", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(api.plan(REQ)).rejects.toThrow();
  });
});
