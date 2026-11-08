import {beforeEach, expect, it, vi} from "vitest";
import {db} from "./index.ts";
import {ensureDbReady} from "./migrationRunner.ts";

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
});

it.each(["VersionError", "UpgradeBlockedError", "QuotaExceededError"])(
  "preserves user data and downloads after %s and permits a later retry", async name => {
    await db.offlineCityMetadata.put({cityId: "vilnius", state: "legacy"});
    await db.savedLocations.put({id: "home", alias: "Home", endpoint: {kind: "mappoint", lat: 1, lon: 2}, savedAt: 1, encrypted: false});
    const deletion = vi.spyOn(db, "delete");
    vi.spyOn(db, "open").mockRejectedValueOnce(Object.assign(new Error(name), {name}));
    await expect(ensureDbReady()).rejects.toMatchObject({name});
    expect(deletion).not.toHaveBeenCalled();
    expect(await ensureDbReady()).toEqual({recovered: false});
    expect(await db.offlineCityMetadata.count()).toBe(1);
    expect(await db.savedLocations.count()).toBe(1);
  },
);
