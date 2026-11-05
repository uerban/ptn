import { describe, it, expect, vi, afterEach } from "vitest";
import type { PrivacyPolicy } from "@pt/shared";
import { LEVEL_FLOORS } from "@pt/shared/privacy";
import {
  buildTransitousQuery,
  planViaTransitous,
  UnsupportedRoutingRequirementError,
} from "./transitousClient.ts";
import { RoutingNotAllowedError } from "./routingSource.ts";

const allow = (): PrivacyPolicy => LEVEL_FLOORS.baseline;
const deny = (): PrivacyPolicy => LEVEL_FLOORS.hardened;
const args = { from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 }, departAtIso: "2026-06-26T08:00:00Z" };

afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("planViaTransitous", () => {
  it("GETs the FLAT /api/plan with adapter=motis + coords, unwrapping data", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { itineraries: [] }, meta: {} }),
        { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await planViaTransitous(args, allow);
    expect(out).toEqual({ itineraries: [] });
    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/api/plan"); // flat, NOT /api/<city>/plan
    expect(calledUrl.searchParams.get("adapter")).toBe("motis");
    expect(calledUrl.searchParams.get("fromLat")).toBe("1");
    expect(calledUrl.searchParams.get("toLon")).toBe("4");
    expect(calledUrl.searchParams.get("departAt")).toBe("2026-06-26T08:00:00Z");
    expect([...calledUrl.searchParams.keys()].sort()).toEqual([
      "adapter",
      "departAt",
      "fromLat",
      "fromLon",
      "toLat",
      "toLon",
    ]);
  });

  it("never serializes PTN's internal mobilityProfile label", () => {
    const query = buildTransitousQuery({
      ...args,
      mobilityProfile: "wheelchair",
    } as typeof args & { mobilityProfile: string });
    expect(query).toEqual({
      adapter: "motis",
      fromLat: "1",
      fromLon: "2",
      toLat: "3",
      toLon: "4",
      departAt: "2026-06-26T08:00:00Z",
    });
    expect(query).not.toHaveProperty("mobilityProfile");
  });

  it("rejects undeclared functional requirements before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      planViaTransitous(
        { ...args, requirements: { stepFree: true } },
        allow,
      ),
    ).rejects.toBeInstanceOf(UnsupportedRoutingRequirementError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses exactly the provider descriptor's semantic fields", () => {
    expect(buildTransitousQuery(args)).toEqual(
      expect.objectContaining({
        fromLat: "1",
        fromLon: "2",
        toLat: "3",
        toLon: "4",
        departAt: "2026-06-26T08:00:00Z",
      }),
    );
  });

  it("throws RoutingNotAllowedError (backstop) when the double-gate is closed, firing NO fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(planViaTransitous(args, deny)).rejects.toBeInstanceOf(RoutingNotAllowedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
