import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import {
  getOrCreateInstallKey,
  InstallKeyError,
  __resetInstallKeyCacheForTests,
} from "./installKey.ts";
import {
  getDegradedMode,
  fallbackTierForLevel,
  shouldWarnAtLevel,
  __resetDegradedModeForTests,
} from "./installKeyDegrade.ts";

describe("installKey", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.installKey.clear();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a key on first call and reuses the persisted one on subsequent calls", async () => {
    const first = await getOrCreateInstallKey();
    const rowsAfterFirst = await db.installKey.toArray();
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0].id).toBe("current");

    __resetInstallKeyCacheForTests();
    const second = await getOrCreateInstallKey();
    const rowsAfterSecond = await db.installKey.toArray();
    // Still a single row — the second call must read, not generate+write.
    expect(rowsAfterSecond).toHaveLength(1);
    // Both CryptoKeys encrypt a known plaintext to ciphertext that the
    // opposite key can decrypt — functional equivalence, since structured
    // clone produces a fresh CryptoKey instance each IDB round-trip.
    const iv = new Uint8Array(12);
    const pt = new TextEncoder().encode("probe");
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, first, pt);
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, second, ct);
    expect(new TextDecoder().decode(decoded)).toBe("probe");
  });

  it("produces a non-extractable AES-GCM 256 key with encrypt + decrypt usages", async () => {
    const key = await getOrCreateInstallKey();
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("rejects exportKey on the install key (non-extractable)", async () => {
    const key = await getOrCreateInstallKey();
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("clears degraded mode on a successful happy-path generation", async () => {
    await getOrCreateInstallKey();
    expect(getDegradedMode()).toBeNull();
  });

  describe("failure paths", () => {
    it("flags `no-crypto` and throws when generateKey is unsupported", async () => {
      const cause = Object.assign(new Error("not supported"), {
        name: "NotSupportedError",
      });
      vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(cause);

      await expect(getOrCreateInstallKey()).rejects.toBeInstanceOf(
        InstallKeyError,
      );
      expect(getDegradedMode()).toBe("no-crypto");
    });

    it("flags `no-persist` and returns an in-memory key on QuotaExceededError", async () => {
      const cause = Object.assign(new Error("quota"), {
        name: "QuotaExceededError",
      });
      vi.spyOn(db.installKey, "put").mockRejectedValue(cause);

      const key = await getOrCreateInstallKey();
      expect(key).toBeDefined();
      expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
      expect(getDegradedMode()).toBe("no-persist");
      // Nothing was written to IDB.
      const rows = await db.installKey.toArray();
      expect(rows).toHaveLength(0);
    });

    it("flags `no-structured-clone` when IDB rejects the CryptoKey with DataCloneError", async () => {
      const cause = Object.assign(new Error("cannot clone CryptoKey"), {
        name: "DataCloneError",
      });
      vi.spyOn(db.installKey, "put").mockRejectedValue(cause);

      const key = await getOrCreateInstallKey();
      expect(key).toBeDefined();
      expect(getDegradedMode()).toBe("no-structured-clone");
    });
  });

  describe("degraded-mode UX policy", () => {
    it("falls back to plaintext only at baseline / standard when there is no crypto", () => {
      expect(fallbackTierForLevel("baseline", "no-crypto")).toBe("plaintext");
      expect(fallbackTierForLevel("standard", "no-crypto")).toBe("plaintext");
      expect(fallbackTierForLevel("hardened", "no-crypto")).toBe("encrypted");
      expect(fallbackTierForLevel("strict", "no-crypto")).toBe("encrypted");
      expect(fallbackTierForLevel("paranoid", "no-crypto")).toBe("encrypted");
    });

    it("does not downgrade tiers for no-persist / no-structured-clone (key is still usable)", () => {
      expect(fallbackTierForLevel("standard", "no-persist")).toBe("encrypted");
      expect(fallbackTierForLevel("hardened", "no-structured-clone")).toBe(
        "encrypted",
      );
    });

    it("warns hardened+ users about any degraded mode but stays silent at baseline / standard", () => {
      expect(shouldWarnAtLevel("baseline", "no-crypto")).toBe(false);
      expect(shouldWarnAtLevel("standard", "no-crypto")).toBe(false);
      expect(shouldWarnAtLevel("hardened", "no-crypto")).toBe(true);
      expect(shouldWarnAtLevel("strict", "no-persist")).toBe(true);
      expect(shouldWarnAtLevel("paranoid", "no-structured-clone")).toBe(true);
      expect(shouldWarnAtLevel("hardened", null)).toBe(false);
    });
  });
});
