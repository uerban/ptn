import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RaptorAdapter } from "../../src/adapters/raptor.ts";
import type { TripQuery } from "@pt/shared";

/**
 * Unit tests for RaptorAdapter.planTrip — focuses on the mobilityProfile
 * mapping from the inbound TripQuery.mobilityProfile (the typed string
 * contract — no parallel bicycle/wheelchair booleans) to the JSON body sent
 * to pt-serve.
 *
 * fetch is globally mocked to capture the request body without a live server.
 */

const EMPTY_WIRE_RESPONSE: object[] = [];

function mockFetchWith(response: object): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeCapturedBody(fetchMock: ReturnType<typeof vi.fn>): object {
  const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

const BASE_QUERY = {
  entryStopIds: ["S1"],
  exitStopIds: ["S2"],
  date: 20260101,
  departureSecs: 28800,
} as TripQuery & {
  entryStopIds: string[];
  exitStopIds: string[];
  date: number;
  departureSecs: number;
};

describe("RaptorAdapter — mobilityProfile mapping", () => {
  const adapter = new RaptorAdapter("http://localhost:8888", "oslo");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps { mobilityProfile: 'bicycle' } → mobilityProfile: 'bicycle'", async () => {
    const fetchMock = mockFetchWith(EMPTY_WIRE_RESPONSE);
    await adapter.planTrip({ ...BASE_QUERY, mobilityProfile: "bicycle" });
    const body = makeCapturedBody(fetchMock);
    expect((body as Record<string, unknown>).mobilityProfile).toBe("bicycle");
  });

  it("maps { mobilityProfile: 'wheelchair' } → mobilityProfile: 'wheelchair'", async () => {
    const fetchMock = mockFetchWith(EMPTY_WIRE_RESPONSE);
    await adapter.planTrip({ ...BASE_QUERY, mobilityProfile: "wheelchair" });
    const body = makeCapturedBody(fetchMock);
    expect((body as Record<string, unknown>).mobilityProfile).toBe("wheelchair");
  });

  it("maps an explicit 'default' profile → mobilityProfile: 'default'", async () => {
    const fetchMock = mockFetchWith(EMPTY_WIRE_RESPONSE);
    await adapter.planTrip({ ...BASE_QUERY, mobilityProfile: "default" });
    const body = makeCapturedBody(fetchMock);
    expect((body as Record<string, unknown>).mobilityProfile).toBe("default");
  });

  it("maps an absent profile → mobilityProfile: 'default'", async () => {
    const fetchMock = mockFetchWith(EMPTY_WIRE_RESPONSE);
    await adapter.planTrip({ ...BASE_QUERY });
    const body = makeCapturedBody(fetchMock);
    expect((body as Record<string, unknown>).mobilityProfile).toBe("default");
  });
});
