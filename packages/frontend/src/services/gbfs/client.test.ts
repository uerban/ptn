import { describe, it, expect, vi, afterEach } from "vitest";
import discoveryV2 from "./__fixtures__/discovery-v2.json";
import discoveryV3 from "./__fixtures__/discovery-v3.json";
import stationInformation from "./__fixtures__/station_information.json";
import stationInformationMalformed from "./__fixtures__/station_information.malformed.json";
import stationStatus from "./__fixtures__/station_status.json";
import {
  fetchDiscovery,
  fetchStationInformation,
  fetchStationStatus,
  mergeStations,
} from "./client.ts";
import { GbfsError } from "./types.ts";
import type { GbfsStationInformationRow, GbfsStationStatusRow } from "./types.ts";

const DISCOVERY_URL = "https://api.cyclocity.fr/contracts/vilnius/gbfs/gbfs.json";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const stubFetch = (impl: (url: string) => Promise<Response>) => {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
};

const expectGbfsError = async (
  promise: Promise<unknown>,
  kind: GbfsError["kind"],
): Promise<GbfsError> => {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GbfsError);
  expect((error as GbfsError).kind).toBe(kind);
  return error as GbfsError;
};

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchDiscovery", () => {
  it("resolves feed URLs from a GBFS 2.x language-keyed discovery doc", async () => {
    const spy = stubFetch(() => Promise.resolve(jsonResponse(discoveryV2)));
    const feeds = await fetchDiscovery(DISCOVERY_URL);
    // Every request carries a timeout signal — a hung feed must not wedge
    // the poll cycle.
    expect(spy).toHaveBeenCalledWith(
      DISCOVERY_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(feeds).toEqual({
      stationInformation:
        "https://api.cyclocity.fr/contracts/vilnius/gbfs/v2/station_information.json",
      stationStatus:
        "https://api.cyclocity.fr/contracts/vilnius/gbfs/v2/station_status.json",
    });
  });

  it("resolves feed URLs from a GBFS 3.0 flat discovery doc", async () => {
    stubFetch(() => Promise.resolve(jsonResponse(discoveryV3)));
    const feeds = await fetchDiscovery(DISCOVERY_URL);
    expect(feeds).toEqual({
      stationInformation:
        "https://api.cyclocity.fr/contracts/vilnius/gbfs/v3/station_information.json",
      stationStatus:
        "https://api.cyclocity.fr/contracts/vilnius/gbfs/v3/station_status.json",
    });
  });

  it("throws GbfsError{kind:'missing-feed'} when station_information is absent", async () => {
    const doc = {
      ...discoveryV2,
      data: {
        fr: {
          feeds: discoveryV2.data.fr.feeds.filter(
            (f) => f.name !== "station_information",
          ),
        },
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "missing-feed");
  });

  it("throws GbfsError{kind:'missing-feed'} when station_status is absent", async () => {
    const doc = {
      ...discoveryV3,
      data: {
        feeds: discoveryV3.data.feeds.filter((f) => f.name !== "station_status"),
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "missing-feed");
  });

  it("throws GbfsError{kind:'http'} with the status on a non-2xx response", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
    const error = await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "http");
    expect(error.status).toBe(503);
    expect(error.url).toBe(DISCOVERY_URL);
  });

  it("throws GbfsError{kind:'parse'} on a non-JSON body", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
    );
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "parse");
  });

  it("throws GbfsError{kind:'parse'} on a JSON body with an unusable shape", async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ hello: "world" })));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "parse");
  });

  it("throws GbfsError{kind:'network'} when fetch rejects", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "network");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["a string", "gbfs"],
  ])("throws GbfsError{kind:'parse'} when the JSON body is %s", async (_label, body) => {
    stubFetch(() => Promise.resolve(jsonResponse(body)));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "parse");
  });

  it("treats a 2.x language block whose feeds are all malformed as missing-feed, not parse", async () => {
    // The feeds ARRAY exists (shape is usable) but no entry survives the
    // per-ref validation — that is "no station_information listed".
    const doc = {
      ...discoveryV2,
      data: { fr: { feeds: [{ name: 42 }, { url: "https://x.test" }, "junk"] } },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "missing-feed");
  });

  it("rejects a resolved feed URL that is not https (parse error)", async () => {
    const doc = {
      ...discoveryV2,
      data: {
        fr: {
          feeds: [
            { name: "station_information", url: "http://api.cyclocity.fr/insecure.json" },
            { name: "station_status", url: "https://api.cyclocity.fr/v2/station_status.json" },
          ],
        },
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "parse");
  });

  it("rejects a resolved feed URL that does not parse as a URL at all", async () => {
    const doc = {
      ...discoveryV2,
      data: {
        fr: {
          feeds: [
            { name: "station_information", url: "not a url" },
            { name: "station_status", url: "https://api.cyclocity.fr/v2/station_status.json" },
          ],
        },
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    await expectGbfsError(fetchDiscovery(DISCOVERY_URL), "parse");
  });
});

describe("fetchStationInformation", () => {
  const INFO_URL = "https://api.cyclocity.fr/contracts/vilnius/gbfs/v2/station_information.json";

  it("returns the station rows from a well-formed feed", async () => {
    stubFetch(() => Promise.resolve(jsonResponse(stationInformation)));
    const rows = await fetchStationInformation(INFO_URL);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      station_id: "1",
      name: "ARKIKATEDRA",
      lat: 54.685908,
      lon: 25.2856,
      address: "Šventaragio g.",
      capacity: 21,
    });
  });

  it("skips malformed rows instead of throwing (tolerant per-row parse)", async () => {
    stubFetch(() => Promise.resolve(jsonResponse(stationInformationMalformed)));
    const rows = await fetchStationInformation(INFO_URL);
    // Fixture: "1" valid, "6" valid-minimal; the other four rows are missing
    // station_id, missing lat, lat as string, station_id as number.
    expect(rows.map((r) => r.station_id)).toEqual(["1", "6"]);
    expect(rows[1]).toEqual({
      station_id: "6",
      name: "VALID MINIMAL",
      lat: 54.678412,
      lon: 25.28214,
    });
  });

  it("rejects out-of-range coordinates and drops invalid capacity", async () => {
    const doc = {
      data: {
        stations: [
          { station_id: "bad-lat", name: "Bad Lat", lat: 90.0001, lon: 25 },
          { station_id: "bad-lon", name: "Bad Lon", lat: 54, lon: -180.0001 },
          {
            station_id: "bad-capacity",
            name: "Bad Capacity",
            lat: 54,
            lon: 25,
            capacity: -1,
          },
          {
            station_id: "fractional-capacity",
            name: "Fractional Capacity",
            lat: 54,
            lon: 25,
            capacity: 2.5,
          },
        ],
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));

    const rows = await fetchStationInformation(INFO_URL);
    expect(rows.map((row) => row.station_id)).toEqual([
      "bad-capacity",
      "fractional-capacity",
    ]);
    expect(rows.every((row) => row.capacity === undefined)).toBe(true);
  });

  it("unwraps a GBFS 3.0 localized name array (first entry's text wins)", async () => {
    const doc = {
      last_updated: "2026-07-17T00:00:00Z",
      ttl: 300,
      version: "3.0",
      data: {
        stations: [
          {
            station_id: "v3-1",
            name: [
              { text: "Katedra", language: "lt" },
              { text: "Cathedral", language: "en" },
            ],
            lat: 54.685908,
            lon: 25.2856,
          },
          // Malformed localized name (empty array) → row skipped, not thrown.
          { station_id: "v3-2", name: [], lat: 54.68, lon: 25.28 },
        ],
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    const rows = await fetchStationInformation(INFO_URL);
    expect(rows).toEqual([
      { station_id: "v3-1", name: "Katedra", lat: 54.685908, lon: 25.2856 },
    ]);
  });

  it("throws GbfsError{kind:'parse'} when data.stations is not an array", async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ last_updated: 1, ttl: 300, version: "2.3", data: {} })),
    );
    await expectGbfsError(fetchStationInformation(INFO_URL), "parse");
  });

  it("throws GbfsError{kind:'http'} on a non-2xx response", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 404 })));
    const error = await expectGbfsError(fetchStationInformation(INFO_URL), "http");
    expect(error.status).toBe(404);
  });
});

describe("fetchStationStatus", () => {
  const STATUS_URL = "https://api.cyclocity.fr/contracts/vilnius/gbfs/v2/station_status.json";

  it("returns the status rows from a well-formed feed", async () => {
    stubFetch(() => Promise.resolve(jsonResponse(stationStatus)));
    const rows = await fetchStationStatus(STATUS_URL);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      station_id: "1",
      num_bikes_available: 4,
      num_docks_available: 17,
      is_installed: true,
      is_renting: true,
      is_returning: true,
      last_reported: 1784250110,
    });
  });

  it("skips malformed status rows instead of throwing", async () => {
    const doc = {
      ...stationStatus,
      data: {
        stations: [
          ...stationStatus.data.stations,
          { station_id: "bad-1" }, // missing counts/flags
          { num_bikes_available: 3, is_installed: true, is_renting: true, is_returning: true }, // no id
          { station_id: "bad-2", num_bikes_available: "3", is_installed: true, is_renting: true, is_returning: true }, // count wrong type
        ],
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    const rows = await fetchStationStatus(STATUS_URL);
    expect(rows.map((r) => r.station_id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("rejects negative/fractional counts and drops invalid optional integers", async () => {
    const flags = { is_installed: true, is_renting: true, is_returning: true };
    const doc = {
      data: {
        stations: [
          { station_id: "negative", num_bikes_available: -1, ...flags },
          { station_id: "fractional", num_bikes_available: 1.5, ...flags },
          {
            station_id: "valid",
            num_bikes_available: 2,
            num_docks_available: -3,
            last_reported: 123.5,
            ...flags,
          },
        ],
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));

    const rows = await fetchStationStatus(STATUS_URL);
    expect(rows).toEqual([
      {
        station_id: "valid",
        num_bikes_available: 2,
        ...flags,
      },
    ]);
  });

  it("accepts GBFS 3.0's num_vehicles_available as the bike count", async () => {
    const doc = {
      last_updated: "2026-07-17T00:00:00Z",
      ttl: 60,
      version: "3.0",
      data: {
        stations: [
          {
            station_id: "v3-1",
            num_vehicles_available: 6,
            num_docks_available: 4,
            is_installed: true,
            is_renting: true,
            is_returning: true,
            // 3.0 last_reported is an RFC 3339 string → dropped, not mangled.
            last_reported: "2026-07-17T12:00:00Z",
          },
        ],
      },
    };
    stubFetch(() => Promise.resolve(jsonResponse(doc)));
    const rows = await fetchStationStatus(STATUS_URL);
    expect(rows).toEqual([
      {
        station_id: "v3-1",
        num_bikes_available: 6,
        num_docks_available: 4,
        is_installed: true,
        is_renting: true,
        is_returning: true,
      },
    ]);
  });

  it("throws GbfsError{kind:'network'} when fetch rejects", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expectGbfsError(fetchStationStatus(STATUS_URL), "network");
  });
});

describe("mergeStations", () => {
  const infoRows = stationInformation.data.stations as GbfsStationInformationRow[];
  const statusRows = stationStatus.data.stations as GbfsStationStatusRow[];

  it("merges counts, flags and last_reported for stations present in both feeds", () => {
    const merged = mergeStations(infoRows, statusRows);
    expect(merged).toHaveLength(5);
    expect(merged[0]).toEqual({
      stationId: "1",
      name: "ARKIKATEDRA",
      lat: 54.685908,
      lon: 25.2856,
      address: "Šventaragio g.",
      capacity: 21,
      bikesAvailable: 4,
      docksAvailable: 17,
      isInstalled: true,
      isRenting: true,
      isReturning: true,
      lastReported: 1784250110,
    });
    // spot-check another row to ensure per-station matching, not positional
    const station4 = merged.find((s) => s.stationId === "4");
    expect(station4).toMatchObject({ bikesAvailable: 2, docksAvailable: 10 });
  });

  it("keeps info order and preserves stations, never inventing rows", () => {
    const merged = mergeStations(infoRows, statusRows);
    expect(merged.map((s) => s.stationId)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("gives a station absent from status null counts and conservative flags", () => {
    const withoutStation5 = statusRows.filter((r) => r.station_id !== "5");
    const merged = mergeStations(infoRows, withoutStation5);
    const station5 = merged.find((s) => s.stationId === "5");
    expect(station5).toEqual({
      stationId: "5",
      name: "FILHARMONIJA",
      lat: 54.676227,
      lon: 25.288612,
      address: "Didžioji g. – Subačiaus g. sankryža",
      capacity: 12,
      bikesAvailable: null,
      docksAvailable: null,
      isInstalled: true,
      isRenting: false,
      isReturning: false,
      lastReported: null,
    });
  });

  // NOTE: mergeStations trusts its typed inputs — malformed-row tolerance
  // lives in (and is tested on) fetchStationInformation/fetchStationStatus,
  // the only producers of these row arrays besides the Dexie cache, which
  // persists already-validated rows.

  it("ignores extra status rows with no matching info row", () => {
    const extraStatus: GbfsStationStatusRow[] = [
      ...statusRows,
      {
        station_id: "999",
        num_bikes_available: 7,
        num_docks_available: 1,
        is_installed: true,
        is_renting: true,
        is_returning: true,
        last_reported: 1784250110,
      },
    ];
    const merged = mergeStations(infoRows, extraStatus);
    expect(merged).toHaveLength(5);
    expect(merged.some((s) => s.stationId === "999")).toBe(false);
  });

  it("maps a status row without optional fields to nulls, not undefined", () => {
    const minimalStatus: GbfsStationStatusRow[] = [
      {
        station_id: "1",
        num_bikes_available: 0,
        is_installed: true,
        is_renting: true,
        is_returning: true,
      },
    ];
    const merged = mergeStations(infoRows.slice(0, 1), minimalStatus);
    expect(merged[0]).toMatchObject({
      bikesAvailable: 0,
      docksAvailable: null,
      lastReported: null,
    });
  });
});
