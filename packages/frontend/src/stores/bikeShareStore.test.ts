import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SharedMobilitySystem } from "../config/cities.ts";
import type { GbfsSystemRow } from "../db/index.ts";
import { GbfsError } from "../services/gbfs/types.ts";
import { cyclocity, makeCity } from "../test-helpers/bikeShareFixtures.ts";

// ---------------------------------------------------------------------------
// Mocks: GBFS client fetchers + Dexie helpers. `mergeStations` stays real
// (pure function; mocking it would just re-test the mock).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  fetchDiscovery: vi.fn(),
  fetchStationInformation: vi.fn(),
  fetchStationStatus: vi.fn(),
  readGbfsSystem: vi.fn(),
  writeGbfsSystem: vi.fn(),
}));

vi.mock("../services/gbfs/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/gbfs/client.ts")>();
  return {
    ...actual,
    fetchDiscovery: mocks.fetchDiscovery,
    fetchStationInformation: mocks.fetchStationInformation,
    fetchStationStatus: mocks.fetchStationStatus,
  };
});

vi.mock("../db/index.ts", () => ({
  readGbfsSystem: mocks.readGbfsSystem,
  writeGbfsSystem: mocks.writeGbfsSystem,
}));

import {
  useBikeShareStore,
  STATUS_POLL_INTERVAL_MS,
  INFO_TTL_MS,
} from "./bikeShareStore.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const vilnius = makeCity("vilnius", [cyclocity]);

const feedUrls = {
  stationInformation: "https://example.test/station_information.json",
  stationStatus: "https://example.test/station_status.json",
};

const infoRows = [
  { station_id: "s1", name: "Station One", lat: 54.68, lon: 25.27, address: "Addr 1", capacity: 20 },
  { station_id: "s2", name: "Station Two", lat: 54.69, lon: 25.28 },
];

const statusRows = [
  {
    station_id: "s1",
    num_bikes_available: 5,
    num_docks_available: 15,
    is_installed: true,
    is_renting: true,
    is_returning: true,
    last_reported: 1_752_000_000,
  },
  {
    station_id: "s2",
    num_bikes_available: 0,
    num_docks_available: 10,
    is_installed: true,
    is_renting: true,
    is_returning: true,
    last_reported: 1_752_000_000,
  },
];

// Cached rows persist the wire shape (snake_case), so fetch results land in
// Dexie as-is and cached rows feed straight back into mergeStations.
const cachedRow: GbfsSystemRow = {
  key: "vilnius:cyclocity",
  fetchedAt: 1000,
  stations: [
    { station_id: "s1", name: "Station One", lat: 54.68, lon: 25.27, address: "Addr 1", capacity: 20 },
    { station_id: "s2", name: "Station Two", lat: 54.69, lon: 25.28 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks without advancing the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

const state = () => useBikeShareStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // degrade()/cache failures warn by design; keep the test output quiet.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Happy-path defaults; individual tests override.
  mocks.fetchDiscovery.mockResolvedValue(feedUrls);
  mocks.fetchStationInformation.mockResolvedValue(infoRows);
  mocks.fetchStationStatus.mockResolvedValue(statusRows);
  mocks.readGbfsSystem.mockResolvedValue(undefined);
  mocks.writeGbfsSystem.mockResolvedValue(undefined);
  // Reset the singleton store between tests.
  state().disable();
  useBikeShareStore.setState({
    enabled: false,
    cityId: null,
    systems: [],
    stations: [],
    status: "idle",
    lastUpdated: null,
  });
});

afterEach(() => {
  state().disable();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// enable(): cached-first render
// ---------------------------------------------------------------------------

describe("bikeShareStore — enable", () => {
  it("without cache: loading → live once the feeds land", async () => {
    const disc = deferred<typeof feedUrls>();
    mocks.fetchDiscovery.mockReturnValue(disc.promise);

    const done = state().enable(vilnius);
    await flush();
    expect(state().enabled).toBe(true);
    expect(state().status).toBe("loading");
    expect(state().stations).toEqual([]);

    disc.resolve(feedUrls);
    await done;
    expect(state().status).toBe("live");
    expect(state().stations).toHaveLength(2);
    expect(state().stations[0]).toMatchObject({
      stationId: "s1",
      bikesAvailable: 5,
      docksAvailable: 15,
      isRenting: true,
    });
    expect(state().lastUpdated).toBe(Date.now());
  });

  it("with cache: cached positions surface immediately (offline-cached), then live", async () => {
    mocks.readGbfsSystem.mockResolvedValue(cachedRow);
    const status = deferred<typeof statusRows>();
    mocks.fetchStationStatus.mockReturnValue(status.promise);

    const done = state().enable(vilnius);
    await flush();
    // Cached positions render before any feed resolves: null counts, grey.
    expect(state().status).toBe("offline-cached");
    expect(state().stations).toHaveLength(2);
    expect(state().stations[0]).toMatchObject({
      stationId: "s1",
      name: "Station One",
      bikesAvailable: null,
      docksAvailable: null,
      isRenting: false,
    });

    status.resolve(statusRows);
    await done;
    expect(state().status).toBe("live");
    expect(state().stations[0]).toMatchObject({ stationId: "s1", bikesAvailable: 5 });
  });

  it("persists freshly fetched station info to Dexie (positions-only wire rows, no mapper)", async () => {
    await state().enable(vilnius);
    expect(mocks.writeGbfsSystem).toHaveBeenCalledTimes(1);
    expect(mocks.writeGbfsSystem).toHaveBeenCalledWith("vilnius", "cyclocity", infoRows);
  });

  it("does NOT persist an empty-but-valid info feed over good cached positions", async () => {
    mocks.fetchStationInformation.mockResolvedValue([]);
    mocks.fetchStationStatus.mockResolvedValue([]);
    await state().enable(vilnius);
    expect(state().status).toBe("live");
    expect(state().stations).toEqual([]);
    // The empty array never reaches Dexie — a cached copy stays usable.
    expect(mocks.writeGbfsSystem).not.toHaveBeenCalled();
  });

  it("proceeds loading → live when the Dexie cache read rejects", async () => {
    mocks.readGbfsSystem.mockRejectedValue(new Error("idb wedged"));
    await state().enable(vilnius);
    expect(state().status).toBe("live");
    expect(state().stations).toHaveLength(2);
  });

  it("total feed failure without cache → error", async () => {
    mocks.fetchDiscovery.mockRejectedValue(new GbfsError("http", "boom", { status: 503 }));
    await state().enable(vilnius);
    expect(state().status).toBe("error");
    expect(state().stations).toEqual([]);
  });

  it("total feed failure with cache → offline-cached, cached positions kept", async () => {
    mocks.readGbfsSystem.mockResolvedValue(cachedRow);
    mocks.fetchDiscovery.mockRejectedValue(new GbfsError("network", "offline"));
    await state().enable(vilnius);
    expect(state().status).toBe("offline-cached");
    expect(state().stations).toHaveLength(2);
    expect(state().stations.every((s) => s.bikesAvailable === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Polling: 60 s status-only repoll, 300 s info TTL
// ---------------------------------------------------------------------------

describe("bikeShareStore — polling", () => {
  it("60 s tick re-fetches station_status only (no discovery, no info)", async () => {
    await state().enable(vilnius);
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(1);
    expect(mocks.fetchStationInformation).toHaveBeenCalledTimes(1);
    expect(mocks.fetchStationStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus).toHaveBeenCalledTimes(2);
    expect(mocks.fetchStationInformation).toHaveBeenCalledTimes(1);
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(1);
    expect(state().status).toBe("live");
    expect(state().lastUpdated).toBe(Date.now());
  });

  it("info is NOT re-fetched while younger than its 300 s TTL", async () => {
    await state().enable(vilnius);
    // Ticks at 60/120/180/240 s: info age < TTL throughout.
    await vi.advanceTimersByTimeAsync(INFO_TTL_MS - STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus).toHaveBeenCalledTimes(5);
    expect(mocks.fetchStationInformation).toHaveBeenCalledTimes(1);
    expect(mocks.writeGbfsSystem).toHaveBeenCalledTimes(1);
  });

  it("info re-fetched once the 300 s TTL lapses, fresh copy written to Dexie", async () => {
    await state().enable(vilnius);
    await vi.advanceTimersByTimeAsync(INFO_TTL_MS);
    // Tick at t=300 s sees info age == TTL → refetch + persist.
    expect(mocks.fetchStationInformation).toHaveBeenCalledTimes(2);
    expect(mocks.writeGbfsSystem).toHaveBeenCalledTimes(2);
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(1); // still never re-discovered
    expect(state().status).toBe("live");
  });

  it("status fetch failure on a tick → offline-cached: positions kept, counts null", async () => {
    await state().enable(vilnius);
    expect(state().stations[0]?.bikesAvailable).toBe(5);

    mocks.fetchStationStatus.mockRejectedValue(new GbfsError("network", "offline"));
    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);

    expect(state().status).toBe("offline-cached");
    expect(state().stations).toHaveLength(2);
    expect(state().stations[0]).toMatchObject({
      stationId: "s1",
      name: "Station One",
      bikesAvailable: null,
      docksAvailable: null,
      isRenting: false,
    });
  });

  it("info-TTL fetch failure at the 300 s tick degrades, then recovers to live", async () => {
    await state().enable(vilnius);
    mocks.fetchStationInformation.mockRejectedValueOnce(new GbfsError("http", "boom", { status: 502 }));

    await vi.advanceTimersByTimeAsync(INFO_TTL_MS);
    // The t=300 s tick tried the info refresh and failed → degrade.
    expect(state().status).toBe("offline-cached");
    expect(state().stations.every((s) => s.bikesAvailable === null)).toBe(true);

    // Next tick retries info (TTL still lapsed) and succeeds → live again.
    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(state().status).toBe("live");
    expect(state().stations[0]).toMatchObject({ stationId: "s1", bikesAvailable: 5 });
  });

  it("a Dexie persist failure is swallowed and polling continues", async () => {
    mocks.writeGbfsSystem.mockRejectedValue(new Error("quota exceeded"));
    await state().enable(vilnius);
    expect(state().status).toBe("live");

    const statusCalls = mocks.fetchStationStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus.mock.calls.length).toBe(statusCalls + 1);
    expect(state().status).toBe("live");
  });

  it("skips a tick while the previous one is still in flight (no overlap)", async () => {
    await state().enable(vilnius);
    const initialCalls = mocks.fetchStationStatus.mock.calls.length;

    const hang = deferred<typeof statusRows>();
    mocks.fetchStationStatus.mockReturnValue(hang.promise);

    // First tick starts and hangs; the second interval fires while it is in
    // flight and must be skipped, not queued behind it.
    await vi.advanceTimersByTimeAsync(2 * STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus.mock.calls.length).toBe(initialCalls + 1);

    hang.resolve(statusRows);
    await flush();
    expect(state().status).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Recovery: a failed enable must not fake "live" or wipe cached positions
// ---------------------------------------------------------------------------

describe("bikeShareStore — recovery after a failed enable", () => {
  it("ticks after a failed enable never fake 'live' and keep cached positions", async () => {
    mocks.readGbfsSystem.mockResolvedValue(cachedRow);
    mocks.fetchDiscovery.mockRejectedValue(new GbfsError("network", "offline"));

    await state().enable(vilnius);
    expect(state().status).toBe("offline-cached");
    expect(state().stations).toHaveLength(2);

    // Still offline: the tick retries the full cycle, fails again — cached
    // grey markers stay, the status stays honest, lastUpdated stays null.
    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(state().status).toBe("offline-cached");
    expect(state().stations).toHaveLength(2);
    expect(state().stations.every((s) => s.bikesAvailable === null)).toBe(true);
    expect(state().lastUpdated).toBeNull();
  });

  it("without cache, repeated failing ticks stay 'error' — never an empty 'live'", async () => {
    mocks.fetchDiscovery.mockRejectedValue(new GbfsError("network", "offline"));
    await state().enable(vilnius);
    expect(state().status).toBe("error");

    await vi.advanceTimersByTimeAsync(3 * STATUS_POLL_INTERVAL_MS);
    expect(state().status).toBe("error");
    expect(state().stations).toEqual([]);
  });

  it("recovers to live on a later tick once the network returns", async () => {
    mocks.fetchDiscovery.mockRejectedValueOnce(new GbfsError("network", "offline"));
    await state().enable(vilnius);
    expect(state().status).toBe("error");
    const discCalls = mocks.fetchDiscovery.mock.calls.length;

    // Network is back: the tick re-runs the full cycle (incl. discovery).
    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchDiscovery.mock.calls.length).toBe(discCalls + 1);
    expect(state().status).toBe("live");
    expect(state().stations).toHaveLength(2);

    // And subsequent ticks are normal status-only repolls again.
    const statusCalls = mocks.fetchStationStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus.mock.calls.length).toBe(statusCalls + 1);
    expect(mocks.fetchDiscovery.mock.calls.length).toBe(discCalls + 1);
  });
});

// ---------------------------------------------------------------------------
// disable() / re-enable / city switch
// ---------------------------------------------------------------------------

describe("bikeShareStore — disable and re-enable", () => {
  it("disable() clears the interval: no fetch fires afterwards (leak guard)", async () => {
    await state().enable(vilnius);
    const statusCalls = mocks.fetchStationStatus.mock.calls.length;

    state().disable();
    expect(state().enabled).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus).toHaveBeenCalledTimes(statusCalls);
    expect(mocks.fetchStationInformation).toHaveBeenCalledTimes(1);
  });

  it("disable mid-flight: a late-resolving fetch must not resurrect the layer", async () => {
    const disc = deferred<typeof feedUrls>();
    mocks.fetchDiscovery.mockReturnValue(disc.promise);

    const done = state().enable(vilnius);
    await flush();
    state().disable();

    disc.resolve(feedUrls);
    await done;
    expect(state().enabled).toBe(false);
    expect(state().status).not.toBe("live");
    await vi.advanceTimersByTimeAsync(10 * STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchStationStatus).not.toHaveBeenCalled();
  });

  it("re-enable reuses in-memory stations (no Dexie read), then refreshes", async () => {
    await state().enable(vilnius);
    state().disable();
    mocks.readGbfsSystem.mockClear();

    const done = state().enable(vilnius);
    // In-memory stations survive the toggle for a cheap re-render.
    expect(state().stations).toHaveLength(2);
    expect(state().enabled).toBe(true);
    await done;

    expect(mocks.readGbfsSystem).not.toHaveBeenCalled();
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(2); // fresh refresh ran
    expect(state().status).toBe("live");
  });

  it("re-enable strips kept counts until the refresh lands (no hours-old numbers)", async () => {
    await state().enable(vilnius);
    expect(state().stations[0]?.bikesAvailable).toBe(5);
    state().disable();

    const disc = deferred<typeof feedUrls>();
    mocks.fetchDiscovery.mockReturnValue(disc.promise);
    const done = state().enable(vilnius);
    await flush();
    // Reused positions render grey — old counts could be arbitrarily stale.
    expect(state().status).toBe("offline-cached");
    expect(state().stations).toHaveLength(2);
    expect(state().stations.every((s) => s.bikesAvailable === null)).toBe(true);
    expect(state().stations.every((s) => s.isRenting === false)).toBe(true);

    disc.resolve(feedUrls);
    await done;
    expect(state().status).toBe("live");
    expect(state().stations[0]?.bikesAvailable).toBe(5);
  });

  it("switching city resets stations and refetches for the new city's config", async () => {
    await state().enable(vilnius);
    expect(state().stations).toHaveLength(2);

    const otherSystem: SharedMobilitySystem = {
      id: "other-bikes",
      name: "Other Bikes",
      gbfsDiscoveryUrl: "https://example.test/other/gbfs.json",
    };
    const otherCity = makeCity("othertown", [otherSystem]);
    mocks.fetchStationInformation.mockResolvedValue([
      { station_id: "o1", name: "Other One", lat: 50.0, lon: 20.0 },
    ]);
    mocks.fetchStationStatus.mockResolvedValue([
      {
        station_id: "o1",
        num_bikes_available: 2,
        num_docks_available: 8,
        is_installed: true,
        is_renting: true,
        is_returning: true,
        last_reported: 1_752_000_100,
      },
    ]);

    const done = state().enable(otherCity);
    // Old city's stations are dropped synchronously — never shown under the
    // new city.
    expect(state().stations).toEqual([]);
    await done;

    expect(state().cityId).toBe("othertown");
    expect(state().systems).toEqual([otherSystem]);
    expect(state().stations).toHaveLength(1);
    expect(state().stations[0]).toMatchObject({ stationId: "o1", bikesAvailable: 2 });
    expect(mocks.fetchDiscovery).toHaveBeenLastCalledWith(otherSystem.gbfsDiscoveryUrl);
  });

  it("switching city clears the open station sheet selection", async () => {
    await state().enable(vilnius);
    state().selectStation("s1");
    expect(state().selectedStationId).toBe("s1");

    await state().enable(makeCity("othertown", []));
    expect(state().selectedStationId).toBeNull();
  });

  it("with several configured systems only the FIRST is live (single-operator scope)", async () => {
    const second: SharedMobilitySystem = {
      id: "second-bikes",
      name: "Second Bikes",
      gbfsDiscoveryUrl: "https://example.test/second/gbfs.json",
    };
    await state().enable(makeCity("twotown", [cyclocity, second]));

    // Config is fully surfaced (the sheet names the first operator), but
    // only the first system is fetched, cached and polled — no half-merged
    // multi-system aggregation, no cross-system station_id collisions.
    expect(state().systems).toEqual([cyclocity, second]);
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(1);
    expect(mocks.fetchDiscovery).toHaveBeenCalledWith(cyclocity.gbfsDiscoveryUrl);
    expect(state().stations).toHaveLength(2);
    expect(mocks.writeGbfsSystem).toHaveBeenCalledTimes(1);
    expect(mocks.writeGbfsSystem).toHaveBeenCalledWith("twotown", "cyclocity", infoRows);

    await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(1); // second system never contacted
  });

  it("switching to a city without sharedMobility empties the layer and stops fetching", async () => {
    await state().enable(vilnius);
    const discCalls = mocks.fetchDiscovery.mock.calls.length;

    await state().enable(makeCity("krakow"));
    expect(state().cityId).toBe("krakow");
    expect(state().systems).toEqual([]);
    expect(state().stations).toEqual([]);
    expect(state().status).toBe("idle");

    // No fetch for the configless city, and the old interval is gone.
    await vi.advanceTimersByTimeAsync(10 * STATUS_POLL_INTERVAL_MS);
    expect(mocks.fetchDiscovery).toHaveBeenCalledTimes(discCalls);
    expect(mocks.fetchStationStatus).toHaveBeenCalledTimes(1);
  });
});
