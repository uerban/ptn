/**
 * `api.getDepartures` targets pt-serve's `departures-for-stop`, not the Node
 * route it used to call — step 4 of the legacy departures retirement notes.
 *
 * Nothing pinned the URL or the parameter spelling before this file, which is
 * the whole substance of that move: the caller-facing signature stays in legacy
 * terms (`time` / `limit` / `lookAheadHours`) and is translated to the route's
 * `from` / `to` / `maxResults` inside `api.getDepartures`. A silent regression
 * there would surface as an empty departures sheet on the fallback path only —
 * exactly the path that is hardest to notice, since the tile path serves the
 * common case.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: {
    getState: () => ({ getApiUrl: () => "/api/vilnius" }),
  },
}));

import { api } from "../../src/services/api.ts";

const ORIGINAL_FETCH = globalThis.fetch;

/** Captures the request the client actually made. */
function captureFetch() {
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data: [], meta: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("api.getDepartures — targets departures-for-stop", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.useRealTimers();
  });

  it("calls /api/<city>/departures-for-stop, not the legacy /departures", async () => {
    const calls = captureFetch();
    await api.getDepartures("stop_1");
    expect(calls[0].url.pathname).toBe("/api/vilnius/departures-for-stop");
  });

  it("sends `from` in unix SECONDS derived from the client clock when `time` is omitted", async () => {
    // `from` is required by the new route where legacy's `time` was optional and
    // defaulted server-side, so the window origin moved to the client clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    const calls = captureFetch();
    await api.getDepartures("stop_1");
    expect(calls[0].url.searchParams.get("from")).toBe("1786363200");
  });

  it("translates an ISO `time` into `from`", async () => {
    const calls = captureFetch();
    await api.getDepartures("stop_1", "2026-08-10T12:00:00.000Z");
    expect(calls[0].url.searchParams.get("from")).toBe("1786363200");
  });

  it("translates `lookAheadHours` into an absolute `to`", async () => {
    const calls = captureFetch();
    await api.getDepartures("stop_1", "2026-08-10T12:00:00.000Z", 100, 24);
    const p = calls[0].url.searchParams;
    expect(p.get("to")).toBe(String(1786363200 + 24 * 3600));
  });

  it("supports FRACTIONAL look-ahead — Home.tsx passes 1.5", async () => {
    // The wire param is an instant, not an hour count, so 1.5 h needs no
    // rounding to a whole hour the way an `lookAheadHours=1.5` query would.
    const calls = captureFetch();
    await api.getDepartures("stop_1", "2026-08-10T12:00:00.000Z", 100, 1.5);
    expect(calls[0].url.searchParams.get("to")).toBe(String(1786363200 + 5400));
  });

  it("omits `to` when no look-ahead is given, leaving the route's 1h default", async () => {
    // Legacy defaulted the same 1h (routes/departures.ts, `parsedLookAhead ?? 1`),
    // so omitting it preserves behaviour rather than widening the window.
    const calls = captureFetch();
    await api.getDepartures("stop_1");
    expect(calls[0].url.searchParams.has("to")).toBe(false);
  });

  it("sends the LEGACY limit defaults explicitly, not the route's flat 100", async () => {
    // The route defaults maxResults to 100; legacy defaulted to 20, or 100 with
    // a look-ahead. Sending it explicitly keeps a caller that omits `limit` on
    // the old behaviour instead of silently quadrupling the row count.
    const calls = captureFetch();
    await api.getDepartures("stop_1");
    expect(calls[0].url.searchParams.get("maxResults")).toBe("20");

    await api.getDepartures("stop_1", undefined, undefined, 2);
    expect(calls[1].url.searchParams.get("maxResults")).toBe("100");

    await api.getDepartures("stop_1", undefined, 7, 2);
    expect(calls[2].url.searchParams.get("maxResults")).toBe("7");
  });

  it("no longer sends x-pt-sw-version", async () => {
    // That header existed only to bucket the legacy route's retirement counter.
    // pt-serve does not read it and the gate it fed is being retired.
    const calls = captureFetch();
    await api.getDepartures("stop_1");
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-pt-sw-version");
  });

  it("DepartureSheet's 24h ask lands exactly ON the route's window bound", async () => {
    // MAX_WINDOW_SECS in crates/pt-serve/src/app/departures_for_stop.rs is 24h
    // and the check is `>`, so exactly 86400 is accepted — with zero headroom.
    // This test exists so that a future narrowing of that bound fails HERE,
    // loudly, instead of turning every sheet open into a 400 in production.
    const calls = captureFetch();
    await api.getDepartures("stop_1", "2026-08-10T12:00:00.000Z", 100, 24);
    const p = calls[0].url.searchParams;
    const span = Number(p.get("to")) - Number(p.get("from"));
    expect(span).toBe(86400);
  });
});
