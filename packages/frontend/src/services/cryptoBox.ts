export const RECORD_VERSION = 1;

export interface EncryptedRecord {
  v: number;
  iv: ArrayBuffer;
  ct: ArrayBuffer;
}

export type CryptoBoxErrorCode =
  | "ciphertext-corrupted"
  | "key-missing"
  | "version-mismatch";

export class CryptoBoxError extends Error {
  readonly code: CryptoBoxErrorCode;
  constructor(code: CryptoBoxErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CryptoBoxError";
    this.code = code;
  }
}

const IV_BYTES = 12;
const ALGO = "AES-GCM";

export async function encrypt(
  plaintext: unknown,
  key: CryptoKey,
): Promise<EncryptedRecord> {
  if (!key) throw new CryptoBoxError("key-missing");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
  const ctBuf = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  // Copy both into fresh ArrayBuffers so they survive jsdom / Node realm boundaries.
  const ivCopy = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivCopy).set(iv);
  const ctCopy = new ArrayBuffer(ctBuf.byteLength);
  new Uint8Array(ctCopy).set(new Uint8Array(ctBuf));
  return { v: RECORD_VERSION, iv: ivCopy, ct: ctCopy };
}

export async function decrypt(
  rec: EncryptedRecord,
  key: CryptoKey,
): Promise<unknown> {
  if (!key) throw new CryptoBoxError("key-missing");
  if (rec.v !== RECORD_VERSION) {
    throw new CryptoBoxError(
      "version-mismatch",
      `unsupported record version: ${String(rec.v)} (expected ${RECORD_VERSION})`,
    );
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: new Uint8Array(rec.iv) },
      key,
      new Uint8Array(rec.ct),
    );
  } catch {
    throw new CryptoBoxError("ciphertext-corrupted");
  }
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text);
}
