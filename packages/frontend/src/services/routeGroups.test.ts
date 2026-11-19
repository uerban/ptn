import { describe, expect, it } from "vitest";
import { CITIES } from "../config/cities.ts";
import { deriveRouteGroups, effectiveExcludedRouteGroups, excludedRouteIdsForGroups, routeGroupFor, toggleRouteGroupSelection } from "./routeGroups.ts";
import type { TransportMode } from "@pt/shared";
const groups = CITIES.find((c) => c.id === "tbilisi")!.routeGroups!;
const routes = ["1:R97525", "1:minibusR25521", "1:minibusR24571"].map((id) => ({ id, mode: "BUS" as const }));
const metro = { id: "1:Metro_Metro_2", mode: "METRO" as const };

describe("operator-defined route groups", () => {
  it("classifies 472 and 532 from their IDs, while retaining regular buses and metro", () => {
    expect(excludedRouteIdsForGroups([...routes, metro], groups, ["minibus"]))
      .toEqual(["1:minibusR24571", "1:minibusR25521"]);
    expect(routeGroupFor(routes[0]!, groups)?.id).toBe("bus");
    expect(routeGroupFor(metro, groups)).toBeUndefined();
  });
  it("does not infer vehicle type from line numbers or colours, or leak TTC rules to another city", () => {
    expect(routeGroupFor({ id: "532", mode: "BUS" }, groups)?.id).toBe("bus");
    expect(routeGroupFor(routes[1]!, [])).toBeUndefined();
    expect(excludedRouteIdsForGroups(routes, [], ["minibus"])).toEqual([]);
  });
  it("keeps both groups on by default, permits regular buses off independently, and can exclude both", () => {
    expect(excludedRouteIdsForGroups(routes, groups, [])).toEqual([]);
    expect(excludedRouteIdsForGroups(routes, groups, ["bus"])).toEqual(["1:R97525"]);
    expect(excludedRouteIdsForGroups(routes, groups, ["bus", "minibus"])).toHaveLength(3);
  });
  it("enabling one child under a legacy Bus exclusion leaves its sibling disabled", () => {
    const selected = toggleRouteGroupSelection(["BUS", "METRO"], [], groups[1]!, groups);
    expect(selected.excludedModes).toEqual(["METRO"]);
    expect(selected.excludedGroups).toEqual(["bus"]);
    expect(toggleRouteGroupSelection(selected.excludedModes, selected.excludedGroups, groups[1]!, groups).excludedGroups)
      .toEqual(["bus", "minibus"]);
  });
  it("does not alter unrelated mode or group choices", () => {
    const modes: TransportMode[] = ["FERRY"];
    const selected = toggleRouteGroupSelection(modes, ["other"], groups[1]!, groups);
    expect(selected).toEqual({ excludedModes: ["FERRY"], excludedGroups: ["other", "minibus"] });
    expect(modes).toEqual(["FERRY"]);
  });
});

describe("feed-derived route groups", () => {
  const bus = (id: string, networkId?: string) => ({ id, mode: "BUS" as const, ...(networkId ? { networkId } : {}) });
  const index = {
    routes: [bus("a", "city"), bus("b", "night"), bus("c"), { id: "t", mode: "TRAM" as const, networkId: "city" }],
    networks: [{ id: "city", name: "City" }, { id: "night", name: "Night" }],
  };

  it("offers one chip per network and a fallback only in modes with a choice", () => {
    const groups = deriveRouteGroups(index, {});
    expect(groups.map((g) => g.id)).toEqual(["city:BUS", "night:BUS", "other:BUS"]);
    expect(groups.map((g) => g.label)).toEqual(["City", "Night", "Bus"]);
    expect(routeGroupFor(bus("c"), groups)?.id).toBe("other:BUS");
  });
  it("applies configured IDs, labels, order and defaults", () => {
    const groups = deriveRouteGroups(index, { routeNetworks: [
      { networkId: "night", id: "late", label: "Late", labelKey: "x.late", order: 1, defaultExcluded: true },
      { networkId: "city", order: 2 },
    ] });
    expect(groups[0]).toMatchObject({ id: "late", label: "Late", labelKey: "x.late", defaultExcluded: true });
    expect(effectiveExcludedRouteGroups(groups, [])).toEqual(["late"]);
    expect(effectiveExcludedRouteGroups(groups, [], ["late"])).toEqual([]);
  });
  it("falls back to configured groups for bundles without networks", () => {
    const city = CITIES.find((c) => c.id === "tbilisi")!;
    expect(deriveRouteGroups({ routes }, city)).toBe(city.routeGroups);
    expect(deriveRouteGroups(null, city)).toBe(city.routeGroups);
  });
  it("keeps Tbilisi selections when the feed starts publishing networks", () => {
    const networked = { routes: [bus("1:R1", "bus"), bus("1:minibusR2", "minibus")] };
    const groups = deriveRouteGroups(networked, { routeNetworks: [{ networkId: "bus", id: "bus" }, { networkId: "minibus", id: "minibus" }] });
    expect(excludedRouteIdsForGroups(networked.routes, groups, ["minibus"])).toEqual(["1:minibusR2"]);
  });
  it("keeps a bare selection across modes and splits it when one variant is enabled", () => {
    const twoModes = { routes: [bus("a", "city"), bus("b", "night"), { id: "t", mode: "TRAM" as const, networkId: "city" }, { id: "u", mode: "TRAM" as const, networkId: "night" }] };
    const groups = deriveRouteGroups(twoModes, {});
    expect(excludedRouteIdsForGroups(twoModes.routes, groups, ["city"])).toEqual(["a", "t"]);
    const cityBus = groups.find((g) => g.id === "city:BUS")!;
    expect(toggleRouteGroupSelection([], ["city"], cityBus, groups).excludedGroups).toEqual(["city:TRAM"]);
  });
});
