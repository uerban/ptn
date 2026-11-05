import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { db } from "./db/index.ts";

// This suite exercises boot WIRING (dispatch / breadcrumbs / registration), not
// POI decompression. A real lazy-tile dispatch reaches decompressBrotli →
// dynamic import("brotli-dec-wasm"), whose module-init fetches its .wasm and —
// under the stubbed global fetch — receives a non-wasm body, throwing an
// UNHANDLED CompileError that can leak ACROSS tests (the dispatch is async and
// outlives the test that started it) and fail the run on exit code. The
// poi-phase2 config stubs pt-wasm but NOT brotli-dec-wasm. Stub the decoder
// module for this file only; the real decode path is covered elsewhere
// (tileLoader.test.ts drives brotli-dec-wasm/web directly via initSync/decompress).
vi.mock("./services/brotliDecode.ts", () => ({
  decompressBrotli: vi.fn(async () => "{}"),
}));

// Local mirror of bootPoi's module-internal config-fetch timeout (the constant
// is not exported; the tests assert behaviour at the SAME value).
const GEOCODER_CONFIG_TIMEOUT_MS_LOCAL = 3000;

describe("boot POI wiring (AC-5c / AC-12 order / AC-13)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("AC-5c: an EXPLICIT server-side city fires zero /poi/*.br after loadGeocoderConfig + syncPoi", async () => {
    fetchSpy = vi.fn(async (url: string) => {
      if (url === "/geocoder-config.json") {
        return new Response(
          JSON.stringify({ kind: "self-hosted", endpoint: "https://geo.example", flavor: "nominatim", multiTenant: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Re-anchor: rung 2 is gone, so a JSON-only geocoder no longer forces server-side. Make the
    // active city EXPLICITLY server-side via the resolver stub so the "server-side suppresses the
    // corpus" coverage is preserved.
    const fm = await import("./services/poiFetchMode.ts");
    vi.spyOn(fm, "resolvePoiFetchMode").mockReturnValue("server-side");

    const boot = await import("./bootPoi.ts");
    const { geocoderRegistry } = await import("./services/geocoder/instance.ts");
    expect(geocoderRegistry).toBeDefined();

    await boot.loadGeocoderConfig();
    boot.syncPoi();
    await vi.waitFor(() => {
      expect(
        infoSpy.mock.calls.some(
          ([msg]) => typeof msg === "string" && msg.includes("[poiSync] resolved"),
        ),
      ).toBe(true);
    });

    const poiUrls = fetchSpy.mock.calls.filter(
      ([u]) => typeof u === "string" && /\/poi\/.*\.br$/.test(u),
    );
    expect(poiUrls).toHaveLength(0);
  });

  it("AC-13: syncPoi emits a resolution breadcrumb naming the source + mode", async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { loadGeocoderConfig, syncPoi } = await import("./bootPoi.ts");
    // loadGeocoderConfig registers the (404 → none) geocoder config; post-Plan-1b
    // it no longer gates the corpus, but we still call it first so the active-city
    // registration matches production boot order.
    await loadGeocoderConfig();
    syncPoi();
    await vi.waitFor(() => {
      expect(
        infoSpy.mock.calls.some(
          ([msg]) => typeof msg === "string" && msg.includes("[poiSync] resolved"),
        ),
      ).toBe(true);
    });

    const breadcrumb = infoSpy.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("[poiSync] resolved"),
    );
    expect(breadcrumb).toBeTruthy();
    const payload = breadcrumb![1] as { cityId: string; resolvedVia: string; mode: string };
    expect(payload).toHaveProperty("cityId");
    // AC-13: assert the EXACT label for this rung. The default active city is
    // CITIES[0] === "vilnius", an activated per-tile POI city. With no override
    // and no geocoder configured (404 JSON), the source stays "operator-default"
    // (the city-config poiFetchMode is NOT a resolutionSource input — only
    // override/server-side change resolvedVia), but the mode is now "lazy-tile"
    // (vilnius carries poiFetchMode: "lazy-tile" post-activation, not the
    // default-off "eager-bundle" rung).
    expect(payload.resolvedVia).toBe("operator-default");
    expect(payload.mode).toBe("lazy-tile");
  });

  it("AC-13: server-side breadcrumb (explicit server-side city) resolves with mode server-side", async () => {
    fetchSpy = vi.fn(async (url: string) => {
      if (url === "/geocoder-config.json") {
        return new Response(
          JSON.stringify({ kind: "self-hosted", endpoint: "https://geo.example", flavor: "nominatim", multiTenant: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Force an explicit server-side active city via the resolver stub (rung 2 gone).
    // resolutionSource has only "user-override" | "operator-default" — an explicit
    // server-side resolution is decided below the override rung, so resolvedVia is
    // "operator-default".
    const fm = await import("./services/poiFetchMode.ts");
    vi.spyOn(fm, "resolvePoiFetchMode").mockReturnValue("server-side");

    const { loadGeocoderConfig, syncPoi } = await import("./bootPoi.ts");
    await loadGeocoderConfig();
    syncPoi();
    await vi.waitFor(() => {
      expect(
        infoSpy.mock.calls.some(
          ([msg]) => typeof msg === "string" && msg.includes("[poiSync] resolved"),
        ),
      ).toBe(true);
    });
    const breadcrumb = infoSpy.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("[poiSync] resolved"),
    );
    const payload = breadcrumb![1] as { cityId: string; resolvedVia: string; mode: string };
    // Explicit server-side is decided BELOW the override rung, so resolvedVia is "operator-default"
    // under the corrected two-value vocabulary (the geocoder branch of resolutionSource is gone).
    expect(payload.resolvedVia).toBe("operator-default");
    expect(payload.mode).toBe("server-side");
  });

  it("AC-5d: boot wires the search-mode accessor — an EXPLICIT server-side active city drives the server-side branch (NOT the local scan)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/geocoder-config.json") {
        return new Response(
          JSON.stringify({ kind: "self-hosted", endpoint: "https://geo.example", flavor: "nominatim", multiTenant: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    }));
    const cityStore = await import("./stores/cityStore.ts");
    const activeCityId = cityStore.useCityStore.getState().activeCity.id;
    const ss = await import("./services/searchSuggestions.ts");
    const { geocoderRegistry } = await import("./services/geocoder/instance.ts");
    // Re-anchor: rung 2 gone — force an explicit server-side resolution so the server-side branch
    // is exercised. The accessor wiring in bootPoi reads the SAME resolver, so stubbing it drives
    // both legs to server-side.
    const fm = await import("./services/poiFetchMode.ts");
    vi.spyOn(fm, "resolvePoiFetchMode").mockReturnValue("server-side");
    const boot = await import("./bootPoi.ts");
    await boot.loadGeocoderConfig();

    const mod = await import("./services/searchSuggestions.ts");
    const scoreSpy = vi.spyOn(mod, "scorePoiRecord");
    const forward = vi.spyOn(geocoderRegistry, "forward").mockResolvedValue([]);
    await db.poiIndex.bulkPut([
      {
        id: "p1", cityId: activeCityId, name: "Central Library",
        geoBucket: `${Math.floor(54.35 * 100)}_${Math.floor(18.65 * 100)}`,
        aliases: {}, category: "public_building", lat: 54.35, lon: 18.65,
        source: "curated", rankBoost: 1.0, tier: "strict",
      } as never,
    ]);
    await ss.searchSuggestions("central", activeCityId, { lat: 54.35, lon: 18.65 }, new AbortController().signal, "local");
    expect(forward).toHaveBeenCalledTimes(1);   // server-side branch taken → wiring is live
    expect(scoreSpy).toHaveBeenCalledTimes(0);  // local poiIndex scan NOT run
  });
});

describe("AC-12 — city-change re-registers; registration precedes dispatch", () => {
  // Own beforeEach so the doMock'd module graph is fresh per `it` and the boot
  // guards do not leak from the AC-5c/AC-13 tests in this file (Should-fix 10).
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  // NOTE: the store SUBSCRIPTIONS (`useCityStore.subscribe(syncPoi)`) live in
  // main.tsx's idle callback, NOT in bootPoi.ts — this test drives `syncPoi()`
  // EXPLICITLY rather than relying on a subscription firing. `setActiveCity`
  // changes the store but does not itself call `syncPoi` here (the subscription
  // is registered only in main.tsx, which this test does not import). The
  // explicit `syncPoi()` calls are the dispatch trigger; the prologue's
  // `lastRegisteredCityId` memo makes them idempotent on an unchanged city.
  it("re-registers on a city swap even when the resolved mode is unchanged, before the dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    const order: string[] = [];
    vi.doMock("./services/geocoder/registerSelfHosted.ts", async (orig) => {
      const real = await orig<typeof import("./services/geocoder/registerSelfHosted.ts")>();
      return {
        ...real,
        syncSelfHostedRegistration: vi.fn((id: string) => { order.push(`register:${id}`); }),
        hasServerSideGeocoder: vi.fn(() => false),
        setRuntimeGeocoderConfig: vi.fn(),
      };
    });
    vi.doMock("./services/poiSync.ts", async (orig) => {
      const real = await orig<typeof import("./services/poiSync.ts")>();
      return {
        ...real,
        syncPoiForCity: vi.fn(async (id: string) => { order.push(`dispatch:${id}`); }),
      };
    });

    // Drive two distinct active cities through the city store between syncPoi
    // calls, using the store's real setter `setActiveCity(city: CityConfig)`
    // (verified in cityStore.ts) — it takes a FULL CityConfig, not an id.
    const { useCityStore } = await import("./stores/cityStore.ts");
    const { CITIES } = await import("./config/cities.ts");
    const { loadGeocoderConfig, syncPoi, __resetBootPoiForTests } = await import("./bootPoi.ts");
    __resetBootPoiForTests();
    // loadGeocoderConfig registers the active-city geocoder config (404 → none),
    // mirroring production boot order. Post-Plan-1b it no longer affects dispatch
    // (the corpus defer is retired); the city-swap order below is driven purely by
    // syncPoi's registration prologue.
    await loadGeocoderConfig();

    // CITIES ships 5 entries (vilnius, tricity, krakow, paris, oslo —
    // verified), NONE carrying a `geocoder` by default (verified). So
    // CITIES[0]/[1] are two distinct ids that BOTH resolve to a non-server-side
    // mode — exactly what this order-assertion needs (Should-fix 18). If a future
    // edit adds a default `geocoder` to CITIES[0]/[1], pick two bare entries by id
    // instead so both still resolve the same mode (the unchanged-mode edge case).
    expect(CITIES.length).toBeGreaterThanOrEqual(2);
    const [cityA, cityB] = [CITIES[0]!, CITIES[1]!];
    expect(cityA.id).not.toBe(cityB.id);

    useCityStore.getState().setActiveCity(cityA);
    syncPoi();
    await Promise.resolve();
    useCityStore.getState().setActiveCity(cityB);
    syncPoi();
    await Promise.resolve();

    // Registration for B must precede dispatch for B.
    const regB = order.indexOf(`register:${cityB.id}`);
    const dispB = order.indexOf(`dispatch:${cityB.id}`);
    expect(regB).toBeGreaterThanOrEqual(0);
    expect(dispB).toBeGreaterThan(regB);
  });

  // `forcePoiResync` is the 409 POI_CORPUS_VERSION_MISMATCH recovery entry
  // point: tileLoader's `handleGenerationMismatch` invalidates the cached
  // tiling and then calls it via `onGenerationMismatch`. It has to do two
  // things, and both are load-bearing in opposite directions — one forces work
  // the memo would skip, the other suppresses work a burst would duplicate.
  it("forcePoiResync bypasses the unchanged-city memo and coalesces concurrent 409s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    const order: string[] = [];
    vi.doMock("./services/poiSync.ts", async (orig) => {
      const real = await orig<typeof import("./services/poiSync.ts")>();
      return {
        ...real,
        syncPoiForCity: vi.fn(async (id: string) => { order.push(`dispatch:${id}`); }),
      };
    });

    const { useCityStore } = await import("./stores/cityStore.ts");
    const { CITIES } = await import("./config/cities.ts");
    const { syncPoi, forcePoiResync, __resetBootPoiForTests } = await import("./bootPoi.ts");
    __resetBootPoiForTests();

    useCityStore.getState().setActiveCity(CITIES[0]!);

    // Baseline dispatch, then a second unforced call the memo must swallow —
    // otherwise the force assertion below proves nothing.
    syncPoi();
    await Promise.resolve();
    syncPoi();
    await Promise.resolve();
    expect(order).toHaveLength(1);

    // A 409 must get through that memo: city, settings and mode are unchanged,
    // which is exactly the case `runPoiSync`'s guard skips. Deleting `!force &&`
    // from that guard makes this line fail.
    forcePoiResync();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toHaveLength(2);

    // A burst of 409s — many tiles fail the same generation check at once —
    // must collapse into ONE run: three synchronous calls, one new dispatch,
    // so the total goes 2 -> 3 rather than 2 -> 5. The calls are deliberately
    // not awaited between, because the guard coalesces only what is genuinely
    // in flight; `.finally()` releases it once a run settles. Deleting
    // `if (forcedResync) return` makes this land on 5.
    forcePoiResync();
    forcePoiResync();
    forcePoiResync();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toHaveLength(3);
  });
});

describe("POI corpus dispatch is config-independent (defer retirement, AC-DR)", () => {
  beforeEach(async () => {
    vi.resetModules();
    // The AC-12 city-swap describe doMocks poiSync / registerSelfHosted; doMock
    // factories survive resetModules and would replace syncPoiForCity with a stub
    // that never dispatches. Unmock so this block imports the real modules.
    vi.doUnmock("./services/poiSync.ts");
    vi.doUnmock("./services/geocoder/registerSelfHosted.ts");
    // useCityStore is persist()-backed; a prior describe's city-swap rehydrates and
    // shifts the active city. Clear it so the dispatch assertions resolve the default.
    localStorage.clear();
    // Clear the shared fake-indexeddb POI tables so a prior eager dispatch's rows do
    // not lengthen loadPoiBundle's IndexedDB chain under the real-timer waitFor.
    // Timeout-guard: a prior test's dangling syncPoiForCity chain may hold an IDB
    // write lock; race against a 2s guard so a failing test never blocks the suite.
    await Promise.race([
      Promise.all([db.poiSyncMeta.clear(), db.poiIndex.clear()]),
      new Promise<void>((res) => setTimeout(res, 2000)),
    ]);
  }, 10_000);
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The breadcrumb "[poiSync] resolved" is logged by syncPoi ONLY past the
  // (now-removed) defer guard — its presence is the mode-agnostic proof that the
  // corpus dispatch was NOT withheld. Pre-retirement, a non-definitive config left
  // resolution UNKNOWN and syncPoi returned before this breadcrumb.

  it("AC-DR1: a valid self-hosted 200 registers the runtime geocoder config", async () => {
    const cfg = { kind: "self-hosted", endpoint: "https://geo.example", flavor: "nominatim", multiTenant: false };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify(cfg), { status: 200, headers: { "content-type": "application/json" } },
    )));
    const reg = await import("./services/geocoder/registerSelfHosted.ts");
    const setSpy = vi.spyOn(reg, "setRuntimeGeocoderConfig");
    const boot = await import("./bootPoi.ts");
    await boot.loadGeocoderConfig();
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "self-hosted" }));
  });

  it("AC-DR2: a definitive 'no config' (404) registers null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const reg = await import("./services/geocoder/registerSelfHosted.ts");
    const setSpy = vi.spyOn(reg, "setRuntimeGeocoderConfig");
    const boot = await import("./bootPoi.ts");
    await boot.loadGeocoderConfig();
    expect(setSpy).toHaveBeenCalledWith(null);
  });

  it("AC-DR3: a FAILED config fetch (network error) registers null AND the local-city corpus STILL dispatches", async () => {
    // Core fix: pre-retirement a network error left configResolution=unknown and the
    // syncPoi defer guard swallowed the dispatch (no breadcrumb). Post-retirement the
    // corpus dispatches regardless. Immediate rejection — no fake timers needed.
    // fetchPoiBundle is mocked to prevent in-flight IDB writes from leaking into the
    // next test's beforeEach (the breadcrumb fires BEFORE fetchPoiBundle is invoked).
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/geocoder-config.json") return Promise.reject(new TypeError("network error"));
      return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
    }));
    const poiLoader = await import("./services/poiLoader.ts");
    vi.spyOn(poiLoader, "fetchPoiBundle").mockResolvedValue(undefined as never);
    const reg = await import("./services/geocoder/registerSelfHosted.ts");
    const setSpy = vi.spyOn(reg, "setRuntimeGeocoderConfig");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const boot = await import("./bootPoi.ts");
    await boot.loadGeocoderConfig();
    expect(setSpy).toHaveBeenCalledWith(null);          // failed fetch → geocoder absent
    boot.syncPoi();
    await vi.waitFor(() => {
      expect(infoSpy.mock.calls.some(
        ([m]) => typeof m === "string" && m.includes("[poiSync] resolved"),
      )).toBe(true);                                    // corpus dispatch NOT deferred
    });
  });

  it("AC-DR4: a HUNG config fetch is abandoned after GEOCODER_CONFIG_TIMEOUT_MS, exactly ONE fetch (no retry), null registered, corpus dispatches", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (url === "/geocoder-config.json") {
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    const reg = await import("./services/geocoder/registerSelfHosted.ts");
    const setSpy = vi.spyOn(reg, "setRuntimeGeocoderConfig");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const boot = await import("./bootPoi.ts");
    const p = boot.loadGeocoderConfig();
    await vi.advanceTimersByTimeAsync(GEOCODER_CONFIG_TIMEOUT_MS_LOCAL);   // trip the one-shot abort
    await p;
    // Advance generously: a (retired) detached retry would fire a 2nd fetch here.
    await vi.advanceTimersByTimeAsync(10_000);
    const cfgFetches = fetchSpy.mock.calls.filter(([u]) => u === "/geocoder-config.json");
    expect(cfgFetches).toHaveLength(1);                 // ONE attempt — retry retired
    expect(setSpy).toHaveBeenCalledWith(null);          // timed-out → geocoder absent
    boot.syncPoi();
    await vi.advanceTimersByTimeAsync(0);
    expect(infoSpy.mock.calls.some(
      ([m]) => typeof m === "string" && m.includes("[poiSync] resolved"),
    )).toBe(true);                                      // corpus dispatch NOT deferred
    vi.useRealTimers();
  });

  it("AC-DR5: an EXPLICIT server-side city suppresses the corpus even when config is unavailable (0 /poi/*.br, mode server-side)", async () => {
    // Suppression is mode-driven (onServerSide), independent of config. A network
    // error on the config fetch (the strongest unavailable stimulus) must not
    // un-suppress the corpus — server-side suppression holds regardless of whether
    // the config is reachable. fetchPoiBundle is mocked to prevent in-flight IDB
    // writes from leaking.
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/geocoder-config.json") return Promise.reject(new TypeError("network error"));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    const poiLoader = await import("./services/poiLoader.ts");
    vi.spyOn(poiLoader, "fetchPoiBundle").mockResolvedValue(undefined as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const fm = await import("./services/poiFetchMode.ts");
    vi.spyOn(fm, "resolvePoiFetchMode").mockReturnValue("server-side");
    const boot = await import("./bootPoi.ts");
    await boot.loadGeocoderConfig();
    boot.syncPoi();
    await vi.waitFor(() => {
      expect(infoSpy.mock.calls.some(
        ([m]) => typeof m === "string" && m.includes("[poiSync] resolved"),
      )).toBe(true);
    });
    const breadcrumb = infoSpy.mock.calls.find(
      ([m]) => typeof m === "string" && m.includes("[poiSync] resolved"),
    );
    expect((breadcrumb![1] as { mode: string }).mode).toBe("server-side");
    const poiUrls = fetchSpy.mock.calls.filter(([u]) => typeof u === "string" && /\/poi\/.*\.br$/.test(u));
    expect(poiUrls).toHaveLength(0);                    // corpus suppressed by mode
  });

  it("AC-DR6: positive control — a local city with a definitive config dispatches >=1 fetchPoiBundle", async () => {
    // RUNS ON REAL TIMERS: the dispatch is async (void syncPoiForCity) and the
    // assertion uses real-timer vi.waitFor. A valid-but-non-self-hosted 200 is a
    // definitive answer → null geocoder → local mode → corpus fetches.
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/geocoder-config.json") {
        return Promise.resolve(new Response(JSON.stringify({ kind: "third-party" }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    const poiLoader = await import("./services/poiLoader.ts");
    const bundleSpy = vi.spyOn(poiLoader, "fetchPoiBundle").mockResolvedValue(undefined as never);
    const boot = await import("./bootPoi.ts");
    await boot.loadGeocoderConfig();
    boot.syncPoi();
    await vi.waitFor(() => { expect(bundleSpy).toHaveBeenCalled(); });
  });
});
