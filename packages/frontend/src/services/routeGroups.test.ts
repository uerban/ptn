import { describe, expect, it } from "vitest";
import { CITIES } from "../config/cities.ts";
import { excludedRouteIdsForGroups, routeGroupFor, toggleRouteGroupSelection } from "./routeGroups.ts";
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
