import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { assignSavedCity, listCitySaves, listUnassignedSaves } from "./citySaves.ts";
import { listSaves, restoreSave, savePlace, saveRoutePair, type SavePayload } from "./saves.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { findLeaks, rawTableText, resetPersonalStorage } from "../test-helpers/personalStorage.ts";

const endpoint = {kind: "stop" as const, stopId: "same-id", name: "Stop", lat: 1, lon: 2};
function payload(alias: string, cityId?: string): SavePayload {
  return {origin: endpoint, alias, savedAt: 1, ...(cityId ? {cityId} : {})};
}
beforeEach(async () => { await resetPersonalStorage(); });

describe("city saved places", () => {
  it("lists only the selected city's saves and preserves absent-catalog owners", async () => {
    await restoreSave("a", payload("a", "vilnius"));
    await restoreSave("b", payload("b", "unavailable-city"));
    await restoreSave("legacy", payload("legacy"));
    expect((await listCitySaves("vilnius")).map(value => value.id)).toEqual(["a"]);
    expect((await listCitySaves("unavailable-city")).map(value => value.id)).toEqual(["b"]);
    expect((await listUnassignedSaves()).map(value => value.id)).toEqual(["legacy"]);
  });

  it("keeps city ownership inside the sealed payload", async () => {
    await restoreSave("a", payload("a", "vilnius"));
    expect(findLeaks(await rawTableText("savedLocations"), ["vilnius"])).toEqual([]);
  });

  it("reads the historical city alias without changing record identities", async () => {
    await restoreSave("alias", payload("alias", "gdansk"));
    expect((await listCitySaves("tricity"))[0]?.id).toBe("alias");
    expect((await listSaves()).find(save => save.id === "alias")?.cityId).toBe("gdansk");
  });

  it("assigns only unowned records and does not overwrite another completed assignment", async () => {
    await restoreSave("legacy", payload("legacy"));
    await assignSavedCity("legacy", "gdansk");
    await assignSavedCity("legacy", "vilnius");
    expect((await listSaves()).find(save => save.id === "legacy")).toMatchObject({alias: "legacy", savedAt: 1, cityId: "tricity"});
  });

  it("resolves sealed aliases and route-pair endpoints for the owning city", async () => {
    const original = useCityStore.getState().activeCity;
    try {
      useCityStore.setState({activeCity: {...original, id: "vilnius"}});
      await saveRoutePair({origin: endpoint, destination: {...endpoint, stopId: "dest"}, alias: "Private pair"}, {id: "pair"});
    } finally { useCityStore.setState({activeCity: original}); }
    expect(await listCitySaves("vilnius")).toEqual([
      expect.objectContaining({id: "pair", alias: "Private pair", origin: endpoint, destination: {...endpoint, stopId: "dest"}, cityId: "vilnius"}),
    ]);
  });

  it("new place writes use captured city ownership through asynchronous encryption", async () => {
    const original = useCityStore.getState().activeCity;
    try {
      useCityStore.setState({activeCity: {...original, id: "vilnius"}});
      const pending = savePlace({endpoint}, {id: "captured"});
      useCityStore.setState({activeCity: {...original, id: "krakow"}});
      expect((await pending).save.cityId).toBe("vilnius");
    } finally { useCityStore.setState({activeCity: original}); }
  });
});
