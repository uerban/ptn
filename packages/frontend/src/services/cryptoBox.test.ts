import { describe, it, expect, beforeAll } from "vitest";
import {
  encrypt,
  decrypt,
  CryptoBoxError,
  RECORD_VERSION,
  type EncryptedRecord,
} from "./cryptoBox.ts";

let key: CryptoKey;

beforeAll(async () => {
  key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
});

describe("cryptoBox encrypt/decrypt", () => {
  it("round-trips a plaintext object through encrypt/decrypt", async () => {
    const value = { hello: "world", nested: { n: 42 }, arr: [1, 2, 3] };
    const rec = await encrypt(value, key);
    const back = await decrypt(rec, key);
    expect(back).toEqual(value);
  });

  it("round-trips primitive types", async () => {
    for (const value of ["string", 0, 3.14, true, false, null]) {
      const rec = await encrypt(value, key);
      expect(await decrypt(rec, key)).toEqual(value);
    }
  });

  it("produces a unique IV for each encryption (10000 distinct IVs)", async () => {
    const seen = new Set<string>();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const rec = await encrypt("payload", key);
      const ivBytes = new Uint8Array(rec.iv);
      // Hex string fingerprint of the IV.
      let hex = "";
      for (let b = 0; b < ivBytes.length; b++) {
        hex += ivBytes[b].toString(16).padStart(2, "0");
      }
      seen.add(hex);
    }
    expect(seen.size).toBe(N);
  });

  it("throws CryptoBoxError('ciphertext-corrupted') when ciphertext is tampered", async () => {
    const rec = await encrypt({ secret: "abc" }, key);
    const tampered = new Uint8Array(rec.ct.byteLength);
    tampered.set(new Uint8Array(rec.ct));
    // Flip one bit in the ciphertext.
    tampered[0] ^= 0x01;
    const corrupted = { v: rec.v, iv: rec.iv, ct: tampered.buffer };
    await expect(decrypt(corrupted, key)).rejects.toBeInstanceOf(CryptoBoxError);
    await expect(decrypt(corrupted, key)).rejects.toMatchObject({
      code: "ciphertext-corrupted",
    });
  });

  it("throws CryptoBoxError('ciphertext-corrupted') when IV is tampered", async () => {
    const rec = await encrypt({ secret: "abc" }, key);
    const ivCopy = new Uint8Array(rec.iv.byteLength);
    ivCopy.set(new Uint8Array(rec.iv));
    ivCopy[0] ^= 0x01;
    const corrupted = { v: rec.v, iv: ivCopy.buffer, ct: rec.ct };
    await expect(decrypt(corrupted, key)).rejects.toMatchObject({
      code: "ciphertext-corrupted",
    });
  });
});

describe("cryptoBox error taxonomy", () => {
  it("encrypt without a key throws CryptoBoxError('key-missing')", async () => {
    const promise = encrypt(
      { secret: "x" },
      undefined as unknown as CryptoKey,
    );
    await expect(promise).rejects.toBeInstanceOf(CryptoBoxError);
    await expect(promise).rejects.toMatchObject({ code: "key-missing" });
  });

  it("decrypt without a key throws CryptoBoxError('key-missing')", async () => {
    const rec = await encrypt({ secret: "y" }, key);
    const promise = decrypt(rec, undefined as unknown as CryptoKey);
    await expect(promise).rejects.toBeInstanceOf(CryptoBoxError);
    await expect(promise).rejects.toMatchObject({ code: "key-missing" });
  });

  it("decrypt with a record from a future version throws 'version-mismatch'", async () => {
    const rec = await encrypt({ secret: "z" }, key);
    const futureRec: EncryptedRecord = { ...rec, v: RECORD_VERSION + 1 };
    const promise = decrypt(futureRec, key);
    await expect(promise).rejects.toBeInstanceOf(CryptoBoxError);
    await expect(promise).rejects.toMatchObject({ code: "version-mismatch" });
  });

  it("decrypt with a record missing the version field throws 'version-mismatch'", async () => {
    const rec = await encrypt({ secret: "w" }, key);
    const legacyRec = { iv: rec.iv, ct: rec.ct } as unknown as EncryptedRecord;
    const promise = decrypt(legacyRec, key);
    await expect(promise).rejects.toMatchObject({ code: "version-mismatch" });
  });

  it("encrypt stamps the current RECORD_VERSION on every record", async () => {
    const rec = await encrypt({ a: 1 }, key);
    expect(rec.v).toBe(RECORD_VERSION);
  });

  it("error codes are distinct across the three failure paths", async () => {
    const rec = await encrypt({ k: "v" }, key);

    // ciphertext-corrupted
    const tampered = new Uint8Array(rec.ct.byteLength);
    tampered.set(new Uint8Array(rec.ct));
    tampered[0] ^= 0x01;
    const corrupt = { v: rec.v, iv: rec.iv, ct: tampered.buffer };

    const errors = await Promise.all([
      decrypt(rec, undefined as unknown as CryptoKey).catch(
        (e: unknown) => (e as CryptoBoxError).code,
      ),
      decrypt({ ...rec, v: 99 }, key).catch(
        (e: unknown) => (e as CryptoBoxError).code,
      ),
      decrypt(corrupt, key).catch(
        (e: unknown) => (e as CryptoBoxError).code,
      ),
    ]);

    expect(new Set(errors)).toEqual(
      new Set(["key-missing", "version-mismatch", "ciphertext-corrupted"]),
    );
  });
});
