import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, type SavedLocationRecord } from "../db/index.ts";
import { assignSavedCity, listCitySaves, resolveSaves } from "./citySaves.ts";
import { savePlace } from "./saves.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { encrypt } from "./cryptoBox.ts";
import { getOrCreateInstallKey } from "./installKey.ts";

const endpoint = {kind: "stop" as const, stopId: "same-id", name: "Stop", lat: 1, lon: 2};
function row(id: string, cityId?: string): SavedLocationRecord {
  return {id, cityId, alias: id, endpoint, encrypted: false, savedAt: 1};
}
beforeEach(async () => { await db.savedLocations.clear(); });

describe("city saved places", () => {
  it("materializes only the selected city's indexed rows and preserves absent-catalog owners", async () => {
    await db.savedLocations.bulkPut([row("a", "vilnius"), row("b", "unavailable-city"), row("legacy")]);
    const reads = vi.fn((value: SavedLocationRecord) => value);
    db.savedLocations.hook("reading", reads);
    try {
      expect((await listCitySaves("vilnius")).map(value => value.id)).toEqual(["a"]);
      expect(reads.mock.calls.map(call => call[0].id)).toEqual(["a"]);
      expect((await listCitySaves("unavailable-city")).map(value => value.id)).toEqual(["b"]);
    } finally { db.savedLocations.hook("reading").unsubscribe(reads); }
  });

  it("reads the historical city alias without changing record identities or ciphertext", async () => {
    await db.savedLocations.put(row("alias", "gdansk"));
    expect((await listCitySaves("tricity"))[0]?.id).toBe("alias");
    expect((await db.savedLocations.get("alias"))?.cityId).toBe("gdansk");
  });

  it("assigns only unowned records and does not overwrite another completed assignment", async () => {
    await db.savedLocations.put(row("legacy"));
    await assignSavedCity("legacy", "gdansk");
    await assignSavedCity("legacy", "vilnius");
    expect(await db.savedLocations.get("legacy")).toEqual({...row("legacy"), cityId: "tricity"});
  });

  it("preserves and resolves sealed aliases and route-pair endpoints", async () => {
    const key = await getOrCreateInstallKey();
    const origin = await encrypt(endpoint, key);
    const destination = await encrypt({...endpoint, stopId: "dest"}, key);
    const aliasCipher = await encrypt("Private pair", key);
    const saved = {...row("pair", "vilnius"), endpoint: origin, destinationEndpoint: destination, alias: "", aliasCipher, encrypted: true};
    await db.savedLocations.put(saved);
    expect(await resolveSaves(await listCitySaves("vilnius"))).toEqual([
      {id: "pair", alias: "Private pair", origin: endpoint, destination: {...endpoint, stopId: "dest"}, savedAt: 1},
    ]);
    expect(await db.savedLocations.get("pair")).toEqual(saved);
  });

  it("new place writes use captured city ownership through asynchronous encryption", async () => {
    const original = useCityStore.getState().activeCity;
    try {
      useCityStore.setState({activeCity: {...original, id: "vilnius"}});
      const pending = savePlace({endpoint}, {tier: "encrypted", id: "captured"});
      useCityStore.setState({activeCity: {...original, id: "krakow"}});
      expect((await pending).cityId).toBe("vilnius");
    } finally { useCityStore.setState({activeCity: original}); }
  });
});
