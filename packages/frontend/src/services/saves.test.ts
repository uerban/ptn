import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import type { BaseEndpoint } from "@pt/shared";
import { db } from "../db/index.ts";
import {
  decrypt,
  __clearRamStoreForTests,
  type EncryptedRecord,
} from "./cryptoBox.ts";
import {
  getOrCreateInstallKey,
  __resetInstallKeyCacheForTests,
} from "./installKey.ts";
import { __resetDegradedModeForTests } from "./installKeyDegrade.ts";
import {
  canExportSaves,
  canShareSaves,
  defaultSensitiveForAxis,
  isSensitiveToggleAvailable,
  migrateSavesForLevelChange,
  savePlace,
  saveRoutePair,
  shouldEncryptAlias,
  stateForSavesAxis,
  tierForSavesAxis,
} from "./saves.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";

const origin: BaseEndpoint = {
  kind: "stop",
  stopId: "S1",
  name: "Central",
  lat: 54.35,
  lon: 18.65,
};

const destination: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.4,
  lon: 18.6,
  label: "Długa 21",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

describe("tierForSavesAxis", () => {
  it("maps opt-in → plaintext", () => {
    expect(tierForSavesAxis("opt-in")).toBe("plaintext");
  });

  it("maps every stricter axis to encrypted", () => {
    expect(tierForSavesAxis("default")).toBe("encrypted");
    expect(tierForSavesAxis("always")).toBe("encrypted");
    expect(tierForSavesAxis("always-no-export")).toBe("encrypted");
    expect(tierForSavesAxis("always-no-share")).toBe("encrypted");
  });
});

describe("saveRoutePair", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    __clearRamStoreForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  it("writes a plaintext pair record at plaintext tier", async () => {
    const rec = await saveRoutePair(
      { origin, destination, alias: "Home → Work" },
      { tier: "plaintext", now: () => 5_000, id: "pair-1" },
    );
    expect(rec.id).toBe("pair-1");
    expect(rec.savedAt).toBe(5_000);
    expect(rec.alias).toBe("Home → Work");
    expect(rec.encrypted).toBe(false);
    expect(rec.endpoint).toEqual(origin);
    expect(rec.destinationEndpoint).toEqual(destination);

    const rows = await db.savedLocations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toEqual(origin);
    expect(rows[0]!.destinationEndpoint).toEqual(destination);
  });

  it("encrypts both endpoints at encrypted tier and keeps metadata plaintext", async () => {
    const rec = await saveRoutePair(
      { origin, destination, alias: "Daily" },
      { tier: "encrypted", now: () => 9_000, id: "pair-2" },
    );
    expect(rec.encrypted).toBe(true);

    const rows = await db.savedLocations.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Endpoint payload must not leak into the persisted row.
    expect(JSON.stringify(row)).not.toContain("Central");
    expect(JSON.stringify(row)).not.toContain("Długa 21");
    // Alias remains plaintext (T-22 will move it inside ciphertext at Paranoid).
    expect(row.alias).toBe("Daily");
    expect(row.savedAt).toBe(9_000);

    const key = await getOrCreateInstallKey();
    const originBack = (await decrypt(
      row.endpoint as EncryptedRecord,
      key,
    )) as BaseEndpoint;
    const destBack = (await decrypt(
      row.destinationEndpoint as EncryptedRecord,
      key,
    )) as BaseEndpoint;
    expect(originBack).toEqual(origin);
    expect(destBack).toEqual(destination);
  });

  it("treats alias as optional (defaults to empty)", async () => {
    const rec = await saveRoutePair(
      { origin, destination },
      { tier: "plaintext" },
    );
    expect(rec.alias).toBe("");
  });

  it("trims whitespace-only alias to empty", async () => {
    const rec = await saveRoutePair(
      { origin, destination, alias: "   " },
      { tier: "plaintext" },
    );
    expect(rec.alias).toBe("");
  });

  it("generates a unique id when none is provided", async () => {
    const a = await saveRoutePair(
      { origin, destination },
      { tier: "plaintext" },
    );
    const b = await saveRoutePair(
      { origin, destination },
      { tier: "plaintext" },
    );
    expect(a.id).not.toBe(b.id);
    const rows = await db.savedLocations.toArray();
    expect(rows).toHaveLength(2);
  });

  it("follows current policy when tier option is omitted", async () => {
    // Baseline → opt-in → plaintext.
    await usePrivacyStore.getState().setLevel("baseline", {
      confirm: () => true,
    });
    const rec = await saveRoutePair({ origin, destination });
    expect(rec.encrypted).toBe(false);

    // Standard's savesEncryption ("default") forces encrypted saves.
    await usePrivacyStore.getState().setLevel("standard");
    const rec2 = await saveRoutePair({ origin, destination });
    expect(rec2.encrypted).toBe(true);
  });

  it("respects `sensitive: true` at Baseline (opt-in) to force encryption", async () => {
    await usePrivacyStore.getState().setLevel("baseline", {
      confirm: () => true,
    });
    const rec = await saveRoutePair({
      origin,
      destination,
      alias: "Clinic",
      sensitive: true,
    });
    expect(rec.encrypted).toBe(true);
    const row = (await db.savedLocations.toArray())[0]!;
    expect(JSON.stringify(row)).not.toContain("Central");
    expect(JSON.stringify(row)).not.toContain("Długa 21");
  });

  it("respects `sensitive: false` at Standard (default) to opt out of encryption", async () => {
    // Standard defaults to encrypted; an explicit false opts out per-save.
    await usePrivacyStore.getState().setLevel("standard");
    const rec = await saveRoutePair({
      origin,
      destination,
      alias: "Coffee",
      sensitive: false,
    });
    expect(rec.encrypted).toBe(false);
    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.endpoint).toEqual(origin);
    expect(row.destinationEndpoint).toEqual(destination);
  });

  it("ignores `sensitive: false` at Hardened (axis forces encryption)", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    const rec = await saveRoutePair({
      origin,
      destination,
      alias: "Gym",
      sensitive: false,
    });
    expect(rec.encrypted).toBe(true);
  });
});

describe("savePlace (single-location save)", () => {
  const pin: BaseEndpoint = { kind: "mappoint", lat: 54.687, lon: 25.2797 };

  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    __clearRamStoreForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  it("writes a plaintext record with NO destination leg", async () => {
    const rec = await savePlace(
      { endpoint: pin, alias: "Allotment" },
      { tier: "plaintext", now: () => 7_000, id: "place-1" },
    );
    expect(rec.id).toBe("place-1");
    expect(rec.savedAt).toBe(7_000);
    expect(rec.alias).toBe("Allotment");
    expect(rec.encrypted).toBe(false);
    expect(rec.endpoint).toEqual(pin);
    // Readers branch on presence, so the key must be absent, not undefined.
    expect("destinationEndpoint" in rec).toBe(false);

    const rows = await db.savedLocations.toArray();
    expect(rows).toHaveLength(1);
    expect("destinationEndpoint" in rows[0]!).toBe(false);
  });

  it("encrypts the endpoint at encrypted tier", async () => {
    await savePlace(
      { endpoint: pin, alias: "Allotment" },
      { tier: "encrypted", id: "place-2" },
    );
    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.encrypted).toBe(true);
    expect(JSON.stringify(row)).not.toContain("25.2797");

    const key = await getOrCreateInstallKey();
    const back = (await decrypt(
      row.endpoint as EncryptedRecord,
      key,
    )) as BaseEndpoint;
    expect(back).toEqual(pin);
  });

  it("seals the alias at the Paranoid axis", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    const rec = await savePlace({ endpoint: pin, alias: "Clinic" });
    expect(rec.encrypted).toBe(true);
    expect(rec.alias).toBe("");
    expect(rec.aliasCipher).toBeDefined();

    const key = await getOrCreateInstallKey();
    expect(await decrypt(rec.aliasCipher!, key)).toBe("Clinic");
  });

  it("follows the current policy tier when no override is passed", async () => {
    await usePrivacyStore.getState().setLevel("baseline", {
      confirm: () => true,
    });
    const rec = await savePlace({ endpoint: pin, alias: "Park" });
    expect(rec.encrypted).toBe(false);
  });

  it("survives a privacy-level migration that re-encodes every row", async () => {
    await usePrivacyStore.getState().setLevel("baseline", {
      confirm: () => true,
    });
    await savePlace({ endpoint: pin, alias: "Park" }, { id: "place-3" });
    await migrateSavesForLevelChange("baseline", "hardened");

    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.id).toBe("place-3");
    expect(row.encrypted).toBe(true);
    expect("destinationEndpoint" in row).toBe(false);
    const key = await getOrCreateInstallKey();
    expect(await decrypt(row.endpoint as EncryptedRecord, key)).toEqual(pin);
  });
});

describe("tier-graded defaults (T-22)", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    __clearRamStoreForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  for (const level of ["hardened", "strict", "paranoid"] as const) {
    it(`encrypts every save by default at ${level}`, async () => {
      await usePrivacyStore.getState().setLevel(level);
      const rec = await saveRoutePair({
        origin,
        destination,
        alias: `At ${level}`,
      });
      expect(rec.encrypted).toBe(true);
      const row = (await db.savedLocations.toArray())[0]!;
      expect(JSON.stringify(row)).not.toContain("Central");
      expect(JSON.stringify(row)).not.toContain("Długa 21");
    });
  }

  it("keeps alias plaintext at Hardened and Strict", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    await saveRoutePair({ origin, destination, alias: "Gym" });
    let row = (await db.savedLocations.toArray())[0]!;
    expect(row.alias).toBe("Gym");
    expect(row.aliasCipher).toBeUndefined();

    await db.savedLocations.clear();
    await usePrivacyStore.getState().setLevel("strict");
    await saveRoutePair({ origin, destination, alias: "Clinic" });
    row = (await db.savedLocations.toArray())[0]!;
    expect(row.alias).toBe("Clinic");
    expect(row.aliasCipher).toBeUndefined();
  });

  it("seals alias inside the encrypted payload at Paranoid", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    const rec = await saveRoutePair({
      origin,
      destination,
      alias: "Therapist",
    });
    expect(rec.encrypted).toBe(true);
    expect(rec.alias).toBe("");
    expect(rec.aliasCipher).toBeDefined();

    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.alias).toBe("");
    expect(row.aliasCipher).toBeDefined();
    // Neither the alias nor the endpoint labels may appear as plaintext.
    expect(JSON.stringify(row)).not.toContain("Therapist");
    expect(JSON.stringify(row)).not.toContain("Central");
    expect(JSON.stringify(row)).not.toContain("Długa 21");

    const key = await getOrCreateInstallKey();
    const aliasBack = (await decrypt(row.aliasCipher!, key)) as string;
    expect(aliasBack).toBe("Therapist");
  });

  it("leaves aliasCipher unset at Paranoid when alias is empty", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    const rec = await saveRoutePair({ origin, destination });
    expect(rec.alias).toBe("");
    expect(rec.aliasCipher).toBeUndefined();
    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.aliasCipher).toBeUndefined();
  });

  it("shouldEncryptAlias flags only the Paranoid axis", () => {
    expect(shouldEncryptAlias("opt-in")).toBe(false);
    expect(shouldEncryptAlias("default")).toBe(false);
    expect(shouldEncryptAlias("always")).toBe(false);
    expect(shouldEncryptAlias("always-no-export")).toBe(false);
    expect(shouldEncryptAlias("always-no-share")).toBe(true);
  });
});

describe("sensitive-toggle helpers", () => {
  it("isSensitiveToggleAvailable is true only at opt-in / default", () => {
    expect(isSensitiveToggleAvailable("opt-in")).toBe(true);
    expect(isSensitiveToggleAvailable("default")).toBe(true);
    expect(isSensitiveToggleAvailable("always")).toBe(false);
    expect(isSensitiveToggleAvailable("always-no-export")).toBe(false);
    expect(isSensitiveToggleAvailable("always-no-share")).toBe(false);
  });

  it("defaultSensitiveForAxis mirrors the policy default tier", () => {
    expect(defaultSensitiveForAxis("opt-in")).toBe(false);
    expect(defaultSensitiveForAxis("default")).toBe(true);
    expect(defaultSensitiveForAxis("always")).toBe(true);
  });
});

describe("stateForSavesAxis", () => {
  it("classifies opt-in as plaintext", () => {
    expect(stateForSavesAxis("opt-in")).toBe("plaintext");
  });

  it("classifies always-no-share as encrypted-sealed-alias", () => {
    expect(stateForSavesAxis("always-no-share")).toBe("encrypted-sealed-alias");
  });

  it("classifies every other axis as encrypted", () => {
    expect(stateForSavesAxis("default")).toBe("encrypted");
    expect(stateForSavesAxis("always")).toBe("encrypted");
    expect(stateForSavesAxis("always-no-export")).toBe("encrypted");
  });
});

describe("migrateSavesForLevelChange (T-25)", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    __clearRamStoreForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
  });

  it("Standard → Paranoid re-encrypts saves and seals alias inside ciphertext", async () => {
    await usePrivacyStore.getState().setLevel("standard");
    await saveRoutePair(
      { origin, destination, alias: "Therapist" },
      { id: "s-1", now: () => 1_000 },
    );
    const before = (await db.savedLocations.toArray())[0]!;
    expect(before.encrypted).toBe(true);
    expect(before.alias).toBe("Therapist");
    expect(before.aliasCipher).toBeUndefined();

    await migrateSavesForLevelChange("standard", "paranoid");

    const after = (await db.savedLocations.toArray())[0]!;
    expect(after.encrypted).toBe(true);
    expect(after.alias).toBe("");
    expect(after.aliasCipher).toBeDefined();
    // No plaintext leakage.
    expect(JSON.stringify(after)).not.toContain("Therapist");
    expect(JSON.stringify(after)).not.toContain("Central");
    expect(JSON.stringify(after)).not.toContain("Długa 21");

    const key = await getOrCreateInstallKey();
    const aliasBack = (await decrypt(after.aliasCipher!, key)) as string;
    expect(aliasBack).toBe("Therapist");
    const originBack = (await decrypt(
      after.endpoint as EncryptedRecord,
      key,
    )) as BaseEndpoint;
    expect(originBack).toEqual(origin);
    const destBack = (await decrypt(
      after.destinationEndpoint as EncryptedRecord,
      key,
    )) as BaseEndpoint;
    expect(destBack).toEqual(destination);
    // Metadata preserved.
    expect(after.id).toBe("s-1");
    expect(after.savedAt).toBe(1_000);
  });

  it("Baseline → Hardened encrypts existing plaintext saves at the new tier", async () => {
    await usePrivacyStore.getState().setLevel("baseline", { confirm: () => true });
    await saveRoutePair(
      { origin, destination, alias: "Coffee" },
      { id: "s-2" },
    );
    const before = (await db.savedLocations.toArray())[0]!;
    expect(before.encrypted).toBe(false);
    expect(before.endpoint).toEqual(origin);

    await migrateSavesForLevelChange("baseline", "hardened");

    const after = (await db.savedLocations.toArray())[0]!;
    expect(after.encrypted).toBe(true);
    expect(after.alias).toBe("Coffee");
    expect(after.aliasCipher).toBeUndefined();
    const key = await getOrCreateInstallKey();
    const back = (await decrypt(
      after.endpoint as EncryptedRecord,
      key,
    )) as BaseEndpoint;
    expect(back).toEqual(origin);
  });

  it("Paranoid → Standard unseals alias back to plaintext metadata", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await saveRoutePair(
      { origin, destination, alias: "Clinic" },
      { id: "s-3" },
    );
    const before = (await db.savedLocations.toArray())[0]!;
    expect(before.alias).toBe("");
    expect(before.aliasCipher).toBeDefined();

    await migrateSavesForLevelChange("paranoid", "standard");

    const after = (await db.savedLocations.toArray())[0]!;
    expect(after.encrypted).toBe(true);
    expect(after.alias).toBe("Clinic");
    expect(after.aliasCipher).toBeUndefined();
  });

  it("Hardened → Baseline (downgrade) decrypts saves back to plaintext", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    await saveRoutePair(
      { origin, destination, alias: "Gym" },
      { id: "s-4" },
    );
    const before = (await db.savedLocations.toArray())[0]!;
    expect(before.encrypted).toBe(true);

    await migrateSavesForLevelChange("hardened", "baseline");

    const after = (await db.savedLocations.toArray())[0]!;
    expect(after.encrypted).toBe(false);
    expect(after.endpoint).toEqual(origin);
    expect(after.destinationEndpoint).toEqual(destination);
    expect(after.alias).toBe("Gym");
    expect(after.aliasCipher).toBeUndefined();
  });

  it("is a no-op when prev and next collapse to the same state", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    await saveRoutePair(
      { origin, destination, alias: "Daily" },
      { id: "s-5" },
    );
    const before = await db.savedLocations.toArray();

    await migrateSavesForLevelChange("hardened", "strict");

    const after = await db.savedLocations.toArray();
    expect(after).toEqual(before);
  });

  it("is a no-op when there are no saves", async () => {
    await expect(
      migrateSavesForLevelChange("standard", "paranoid"),
    ).resolves.toBeUndefined();
    expect(await db.savedLocations.count()).toBe(0);
  });

  it("is invoked automatically by privacyStore.setLevel", async () => {
    await usePrivacyStore.getState().setLevel("standard");
    await saveRoutePair(
      { origin, destination, alias: "Friend" },
      { id: "s-6" },
    );
    const ok = await usePrivacyStore.getState().setLevel("paranoid");
    expect(ok).toBe(true);

    const after = (await db.savedLocations.toArray())[0]!;
    expect(after.alias).toBe("");
    expect(after.aliasCipher).toBeDefined();
  });

  it("downgrade via setLevel honours the confirm callback and aborts on cancel", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await saveRoutePair(
      { origin, destination, alias: "Sealed" },
      { id: "s-7" },
    );
    const before = (await db.savedLocations.toArray())[0]!;
    expect(before.aliasCipher).toBeDefined();

    let warned = false;
    const ok = await usePrivacyStore.getState().setLevel("standard", {
      confirm: (msg) => {
        warned = msg.length > 0;
        return false;
      },
    });
    expect(ok).toBe(false);
    expect(warned).toBe(true);

    const stillSealed = (await db.savedLocations.toArray())[0]!;
    expect(stillSealed.alias).toBe("");
    expect(stillSealed.aliasCipher).toBeDefined();
  });
});

describe("export/share visibility helpers (T-23)", () => {
  it("canExportSaves hides export at Strict and Paranoid only", () => {
    expect(canExportSaves("opt-in")).toBe(true);
    expect(canExportSaves("default")).toBe(true);
    expect(canExportSaves("always")).toBe(true);
    expect(canExportSaves("always-no-export")).toBe(false);
    expect(canExportSaves("always-no-share")).toBe(false);
  });

  it("canShareSaves hides share at Paranoid only", () => {
    expect(canShareSaves("opt-in")).toBe(true);
    expect(canShareSaves("default")).toBe(true);
    expect(canShareSaves("always")).toBe(true);
    expect(canShareSaves("always-no-export")).toBe(true);
    expect(canShareSaves("always-no-share")).toBe(false);
  });
});
