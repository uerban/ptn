import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import {
  getOrCreateHmacKey,
  getOrCreateInstallKey,
  InstallKeyError,
  isInstallKeyDurable,
  KEY_READ_RETRY_MS,
  resetInstallKeys,
  retryInstallKeyReadNow,
  __resetInstallKeyCacheForTests,
  __setInstallKeyClockForTests,
} from "./installKey.ts";
import {
  getDegradedMode,
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
      vi.spyOn(db.installKey, "add").mockRejectedValue(cause);

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
      vi.spyOn(db.installKey, "add").mockRejectedValue(cause);

      const key = await getOrCreateInstallKey();
      expect(key).toBeDefined();
      expect(getDegradedMode()).toBe("no-structured-clone");
    });
  });

  describe("read failures and unusable keys", () => {
    async function rawKeyRow() {
      return db.installKey.get("current");
    }

    it("never replaces the stored key when reading it fails", async () => {
      await getOrCreateInstallKey();
      const before = await rawKeyRow();
      __resetInstallKeyCacheForTests();
      const addSpy = vi.spyOn(db.installKey, "add");
      const putSpy = vi.spyOn(db.installKey, "put");
      vi.spyOn(db.installKey, "get").mockRejectedValueOnce(
        Object.assign(new Error("read failed"), { name: "UnknownError" }),
      );

      await expect(getOrCreateInstallKey()).rejects.toMatchObject({
        mode: "read-failed",
      });
      expect(getDegradedMode()).toBe("read-failed");
      expect(isInstallKeyDurable()).toBe(false);
      expect(addSpy).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      expect(await rawKeyRow()).toEqual(before);
    });

    it("waits before re-reading, then recovers the stored key", async () => {
      let now = 1_000;
      __setInstallKeyClockForTests(() => now);
      const original = await getOrCreateInstallKey();
      __resetInstallKeyCacheForTests();
      __setInstallKeyClockForTests(() => now);
      const getSpy = vi
        .spyOn(db.installKey, "get")
        .mockRejectedValueOnce(new Error("read failed"));

      await expect(getOrCreateInstallKey()).rejects.toBeInstanceOf(InstallKeyError);
      // Inside the retry window no read is attempted.
      await expect(getOrCreateInstallKey()).rejects.toBeInstanceOf(InstallKeyError);
      expect(getSpy).toHaveBeenCalledTimes(1);

      now += KEY_READ_RETRY_MS + 1;
      const recovered = await getOrCreateInstallKey();
      expect(getDegradedMode()).toBeNull();
      expect(isInstallKeyDurable()).toBe(true);
      const iv = new Uint8Array(12);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        original,
        new TextEncoder().encode("probe"),
      );
      await expect(
        crypto.subtle.decrypt({ name: "AES-GCM", iv }, recovered, ct),
      ).resolves.toBeDefined();
    });

    it("retries a failed read at once when asked", async () => {
      await getOrCreateInstallKey();
      __resetInstallKeyCacheForTests();
      vi.spyOn(db.installKey, "get").mockRejectedValueOnce(new Error("read failed"));
      await expect(getOrCreateInstallKey()).rejects.toBeInstanceOf(InstallKeyError);
      retryInstallKeyReadNow();
      await expect(getOrCreateInstallKey()).resolves.toBeDefined();
      expect(getDegradedMode()).toBeNull();
    });

    it("refuses a corrupt key row and never overwrites it", async () => {
      await db.installKey.put({
        id: "current",
        key: { corrupt: true } as unknown as CryptoKey,
      });
      const addSpy = vi.spyOn(db.installKey, "add");
      const putSpy = vi.spyOn(db.installKey, "put");

      await expect(getOrCreateInstallKey()).rejects.toMatchObject({
        mode: "key-unreadable",
      });
      expect(getDegradedMode()).toBe("key-unreadable");
      // A retry request does not lift it either.
      retryInstallKeyReadNow();
      await expect(getOrCreateInstallKey()).rejects.toBeInstanceOf(InstallKeyError);
      expect(addSpy).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      expect((await rawKeyRow())?.key).toEqual({ corrupt: true });
    });

    it("starts over only through resetInstallKeys", async () => {
      await db.installKey.put({
        id: "current",
        key: { corrupt: true } as unknown as CryptoKey,
      });
      await expect(getOrCreateInstallKey()).rejects.toBeInstanceOf(InstallKeyError);
      await resetInstallKeys();
      expect(getDegradedMode()).toBeNull();
      const key = await getOrCreateInstallKey();
      expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
      expect(isInstallKeyDurable()).toBe(true);
    });

    it("adopts the key another tab stored first instead of overwriting it", async () => {
      const winner = (await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )) as CryptoKey;
      const realAdd = db.installKey.add.bind(db.installKey);
      vi.spyOn(db.installKey, "add").mockImplementationOnce((async (
        row: Parameters<typeof realAdd>[0],
      ) => {
        // The other tab wins the race between our read and our write.
        await realAdd({ id: "current", key: winner });
        return realAdd(row);
      }) as never);

      const key = await getOrCreateInstallKey();
      const iv = new Uint8Array(12);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        winner,
        new TextEncoder().encode("probe"),
      );
      await expect(
        crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
      ).resolves.toBeDefined();
      expect(isInstallKeyDurable()).toBe(true);
      expect(await db.installKey.count()).toBe(1);
    });

    it("reports a session-only key as not durable", async () => {
      vi.spyOn(db.installKey, "add").mockRejectedValue(
        Object.assign(new Error("quota"), { name: "QuotaExceededError" }),
      );
      await getOrCreateInstallKey();
      expect(isInstallKeyDurable()).toBe(false);
    });
  });

  describe("HMAC key", () => {
    it("is a separate non-extractable HMAC key stored beside the AES key", async () => {
      const hmac = await getOrCreateHmacKey();
      await getOrCreateInstallKey();
      expect(hmac.algorithm).toMatchObject({ name: "HMAC" });
      expect(hmac.extractable).toBe(false);
      const ids = (await db.installKey.toArray()).map((r) => r.id).sort();
      expect(ids).toEqual(["current", "hmac"]);
    });
  });
});
