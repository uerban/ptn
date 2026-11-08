import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PatternMode } from "@pt/shared/raptor";
import { db } from "../db/index.ts";
import {
  DATA_SCHEMA_VERSION,
  ensureDataSchemaUpToDate,
} from "../db/dataSchemaVersion.ts";
import {
  fetchPtbBytes,
  fetchPtbBytesPreferCache,
  PtbBytesUnavailableError,
} from "./gtfsBundleBytes.ts";

// Walk up from cwd to the repo root (vitest's cwd is the package dir under turbo
// but the project root when run directly). Mirrors crates/pt-core/tests/raptor_behavior.rs.
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  throw new Error("gtfsBundleBytes.test: could not locate repo root from " + process.cwd());
}

// A real committed PTB (current v1, feedStartDate=20260601, no 0x01 WindowMeta
// ⇒ the default 90-day window). Used to prove the write path decodes window
// provenance from the persisted bytes. horizonEndDate = 20260601 + 90 civil
// days = 20260830.
const REAL_PTB_BYTES = new Uint8Array(
  readFileSync(
    resolve(findRepoRoot(), "packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb"),
  ),
);

vi.mock("./gtfsQuotaGuard.ts", () => ({
  shouldWriteShapes: vi.fn(async () => true),
}));

const ORIG_FETCH = globalThis.fetch;

function mockBytes(
  bytes: Uint8Array,
  etag = '"v1"',
  headers: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async () => new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "application/octet-stream", etag, ...headers },
  })) as unknown as typeof fetch;
}

describe("artifact-owned byte acquisition", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.ptbBytes.clear();
    const {shouldWriteShapes} = await import("./gtfsQuotaGuard.ts");
    vi.mocked(shouldWriteShapes).mockReset().mockResolvedValue(true);
  });
  afterEach(() => { globalThis.fetch = ORIG_FETCH; vi.restoreAllMocks(); });

  it("returns fresh bytes without depending on quota inspection or a legacy write", async () => {
    const {shouldWriteShapes} = await import("./gtfsQuotaGuard.ts");
    vi.mocked(shouldWriteShapes).mockReturnValue(new Promise(() => {}));
    const put = vi.spyOn(db.ptbBytes, "put");
    globalThis.fetch = mockBytes(REAL_PTB_BYTES);
    const result = await fetchPtbBytes("vilnius", {persist: false});
    expect(result.bytes.byteLength).toBe(REAL_PTB_BYTES.byteLength);
    expect(shouldWriteShapes).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("revalidates the owning artifact after the legacy cache was evicted", async () => {
    const cached = {bytes: REAL_PTB_BYTES, etag: '"artifact"', cityTzIana: "Europe/Vilnius",
      fromCache: true, networkValidated: false, transfersResolved: true};
    const read = vi.spyOn(db.ptbBytes, "get");
    const put = vi.spyOn(db.ptbBytes, "put");
    globalThis.fetch = vi.fn(async (_url, options) => {
      expect(new Headers(options?.headers).get("If-None-Match")).toBe(cached.etag);
      return new Response(null, {status: 304, headers: {"X-PT-Raptor-Bundle-Provenance": "transfers-v1"}});
    });
    const result = await fetchPtbBytes("vilnius", {persist: false, cached});
    expect(result.bytes).toBe(cached.bytes);
    expect(result.networkValidated).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not join a legacy request stalled on persistence", async () => {
    const Dexie = (await import("dexie")).default;
    let finish!: () => void;
    const stalled = new Dexie.Promise<string>(resolve => {finish = () => resolve("vilnius");});
    const put = vi.spyOn(db.ptbBytes, "put").mockReturnValueOnce(stalled);
    globalThis.fetch = mockBytes(REAL_PTB_BYTES);
    const legacy = fetchPtbBytes("vilnius");
    try {
      await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
      const result = await fetchPtbBytes("vilnius", {persist: false});
      expect(result.networkValidated).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally { finish(); await legacy; }
  });
});

describe("fetchPtbBytes (network-first)", () => {
  beforeEach(async () => {
    if (db.isOpen()) await db.close();
    await (await import("dexie")).default.delete("ptn");
    await db.open();
    const { shouldWriteShapes } = await import("./gtfsQuotaGuard.ts");
    (shouldWriteShapes as unknown as { mockReset: () => void; mockResolvedValue: (v: boolean) => void })
      .mockReset();
    (shouldWriteShapes as unknown as { mockResolvedValue: (v: boolean) => void })
      .mockResolvedValue(true);
  });
  afterEach(() => { globalThis.fetch = ORIG_FETCH; });

  it("fetches, persists to IDB, returns the bytes", async () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);
    globalThis.fetch = mockBytes(bytes, '"v1"', {
      "X-PT-City-Tz-Iana": "Europe/Vilnius",
    });
    const result = await fetchPtbBytes("vilnius");
    expect(Array.from(result.bytes)).toEqual([0x50, 0x54, 0x42, 0x00]);
    expect(result.networkValidated).toBe(true);
    expect(result.cityTzIana).toBe("Europe/Vilnius");
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.etag).toBe('"v1"');
    expect(row?.cityTzIana).toBe("Europe/Vilnius");
    // 200 sets BOTH timestamps.
    expect(row?.firstStoredAt).toBeGreaterThan(0);
    expect(row?.lastValidatedAt).toBeGreaterThan(0);
    expect(row?.firstStoredAt).toBe(row?.lastValidatedAt);
  });

  it("persists window provenance (windowDays + horizonEndDate) decoded from real PTB bytes", async () => {
    globalThis.fetch = mockBytes(REAL_PTB_BYTES, '"vreal"');
    await fetchPtbBytes("vilnius");
    const row = await db.ptbBytes.get("vilnius");
    // tiny-service-pool.ptb has no 0x01 region ⇒ default 90; feedStartDate 20260601.
    expect(row?.windowDays).toBe(90);
    expect(row?.horizonEndDate).toBe("20260830");
  });

  it("degrades window provenance gracefully on non-PTB bytes (never blocks persist)", async () => {
    // The 4-byte placeholder is not a valid PTB header → defaults, no throw.
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);
    globalThis.fetch = mockBytes(bytes);
    const result = await fetchPtbBytes("vilnius");
    expect(Array.from(result.bytes)).toEqual([0x50, 0x54, 0x42, 0x00]);
    const row = await db.ptbBytes.get("vilnius");
    expect(row).toBeDefined();
    expect(row?.windowDays).toBe(90);
    // feedStartDate undecodable ⇒ empty horizon string (best-effort).
    expect(row?.horizonEndDate).toBe("");
  });

  it("sends If-None-Match (case-insensitive header read in test)", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([1]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
      cityTzIana: "Europe/Vilnius",
    });
    let seen: Headers | null = null;
    globalThis.fetch = vi.fn(async (_url: unknown, init: { headers?: HeadersInit } = {}) => {
      seen = new Headers(init.headers ?? {});
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const result = await fetchPtbBytes("vilnius");
    expect(seen!.get("if-none-match")).toBe('"v1"');
    expect(Array.from(result.bytes)).toEqual([1]);
    expect(result.fromCache).toBe(true);
    expect(result.networkValidated).toBe(true);

    // 304 path: lastValidatedAt advances, firstStoredAt frozen.
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.firstStoredAt).toBe(seedAt);
    expect(row?.lastValidatedAt).toBeGreaterThan(seedAt);
    // ETag and bytes unchanged on 304.
    expect(row?.etag).toBe('"v1"');
    expect(Array.from(row!.bytes as Uint8Array)).toEqual([1]);
    expect(row?.cityTzIana).toBe("Europe/Vilnius");
    expect(result.cityTzIana).toBe("Europe/Vilnius");
  });

  it("rejects a present but invalid bundle timezone without persisting bytes", async () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);
    globalThis.fetch = mockBytes(bytes, '"v1"', {
      "X-PT-City-Tz-Iana": "Not/A_Timezone",
    });

    await expect(fetchPtbBytes("vilnius")).rejects.toThrow(
      "invalid X-PT-City-Tz-Iana",
    );
    expect(await db.ptbBytes.get("vilnius")).toBeUndefined();
  });

  it("304 without cached record throws (server bug — would otherwise persist 0-byte cache)", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    await expect(fetchPtbBytes("vilnius")).rejects.toBeInstanceOf(PtbBytesUnavailableError);
  });

  it("falls back to IDB cache on network error", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([7]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
    });
    globalThis.fetch = vi.fn(async () => { throw new TypeError("net"); }) as unknown as typeof fetch;
    const result = await fetchPtbBytes("vilnius");
    expect(Array.from(result.bytes)).toEqual([7]);
    expect(result.fromCache).toBe(true);
    expect(result.networkValidated).toBe(false);
    // Network error must NOT update lastValidatedAt (we never heard from the server).
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.lastValidatedAt).toBe(seedAt);
  });

  it("throws PtbBytesUnavailableError when no network and no cache", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("net"); }) as unknown as typeof fetch;
    await expect(fetchPtbBytes("vilnius")).rejects.toBeInstanceOf(PtbBytesUnavailableError);
  });

  it("skips IDB persist when quota guard returns false but still returns bytes", async () => {
    const { shouldWriteShapes } = await import("./gtfsQuotaGuard.ts");
    (shouldWriteShapes as unknown as { mockResolvedValueOnce: (v: boolean) => void })
      .mockResolvedValueOnce(false);
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00, 9]);
    globalThis.fetch = mockBytes(bytes);

    const result = await fetchPtbBytes("vilnius");
    expect(Array.from(result.bytes)).toEqual([0x50, 0x54, 0x42, 0x00, 9]);
    expect(await db.ptbBytes.get("vilnius")).toBeUndefined();
  });

  it("returns bytes (does not throw) when IDB put rejects with QuotaExceededError", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = mockBytes(bytes);
    const putSpy = vi.spyOn(db.ptbBytes, "put").mockRejectedValueOnce(
      Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" }),
    );

    const result = await fetchPtbBytes("vilnius");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
    expect(result.fromCache).toBe(false);
    expect(putSpy).toHaveBeenCalled();
    // Nothing persisted.
    expect(await db.ptbBytes.get("vilnius")).toBeUndefined();
    putSpy.mockRestore();
  });

  it("persists and returns transfer manifest from raptor-bundle headers on 200", async () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);
    globalThis.fetch = mockBytes(bytes, '"v1"', {
      "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
      "X-PT-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
      "X-PT-Transfers-Artifact-Hash": "abc123",
      "X-PT-Transfers-Artifact-Size": "42",
    });

    const result = await fetchPtbBytes("vilnius");
    expect(result.transfersArtifact).toEqual({
      url: "/api/vilnius/transfers/fetch",
      hash: "abc123",
      sizeBytes: 42,
    });
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.transfersArtifact).toEqual(result.transfersArtifact);
  });

  it("does not read the pre-rename X-PTN- header spelling", async () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00]);
    globalThis.fetch = mockBytes(bytes, '"v1"', {
      "X-PTN-Raptor-Bundle-Provenance": "transfers-v1",
      "X-PTN-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
      "X-PTN-Transfers-Artifact-Hash": "oldhash",
      "X-PTN-Transfers-Artifact-Size": "42",
    });

    const result = await fetchPtbBytes("vilnius");
    expect(result.transfersResolved).toBe(false);
    expect(result.transfersArtifact).toBeUndefined();
  });

  it("updates transfer manifest on 304 without changing bytes", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([1]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
      transfersArtifact: { url: "/old", hash: "old", sizeBytes: 1 },
    });

    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 304,
      headers: {
        "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
        "X-PT-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
        "X-PT-Transfers-Artifact-Hash": "new",
        "X-PT-Transfers-Artifact-Size": "42",
      },
    })) as unknown as typeof fetch;

    const result = await fetchPtbBytes("vilnius");
    expect(Array.from(result.bytes)).toEqual([1]);
    expect(result.transfersArtifact?.hash).toBe("new");
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.transfersArtifact?.hash).toBe("new");
  });

  it("clears stale transfer manifest when capability header is present and transfer headers are absent", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([1]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
      transfersArtifact: { url: "/old", hash: "old", sizeBytes: 1 },
    });

    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 304,
      headers: { "X-PT-Raptor-Bundle-Provenance": "transfers-v1" },
    })) as unknown as typeof fetch;
    const result = await fetchPtbBytes("vilnius");
    expect(result.transfersArtifact).toBeUndefined();
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.transfersArtifact).toBeUndefined();
  });

  it("preserves cached transfer manifest when an old server lacks the capability header", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([1]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
      transfersArtifact: { url: "/old", hash: "old", sizeBytes: 1 },
    });

    globalThis.fetch = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const result = await fetchPtbBytes("vilnius");
    expect(result.transfersArtifact?.hash).toBe("old");
    const row = await db.ptbBytes.get("vilnius");
    expect(row?.transfersArtifact?.hash).toBe("old");
  });

  it("returns the cached transfer manifest on network-error fallback", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([7]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
      transfersArtifact: { url: "/api/vilnius/transfers/fetch", hash: "cached", sizeBytes: 9 },
    });
    globalThis.fetch = vi.fn(async () => { throw new TypeError("net"); }) as unknown as typeof fetch;

    const result = await fetchPtbBytes("vilnius");
    expect(result.fromCache).toBe(true);
    expect(result.transfersArtifact).toEqual({
      url: "/api/vilnius/transfers/fetch",
      hash: "cached",
      sizeBytes: 9,
    });
  });

  it("returns the response transfer manifest even when quota guard skips IDB persist", async () => {
    const { shouldWriteShapes } = await import("./gtfsQuotaGuard.ts");
    (shouldWriteShapes as unknown as { mockResolvedValueOnce: (v: boolean) => void })
      .mockResolvedValueOnce(false);
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00, 9]);
    globalThis.fetch = mockBytes(bytes, '"v1"', {
      "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
      "X-PT-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
      "X-PT-Transfers-Artifact-Hash": "fromheaders",
      "X-PT-Transfers-Artifact-Size": "42",
    });

    const result = await fetchPtbBytes("vilnius");
    // Persist skipped: nothing reaches IDB...
    expect(await db.ptbBytes.get("vilnius")).toBeUndefined();
    // ...but the in-memory result still carries the header manifest so the
    // current session's wasm transfer-attach still works.
    expect(result.transfersArtifact).toEqual({
      url: "/api/vilnius/transfers/fetch",
      hash: "fromheaders",
      sizeBytes: 42,
    });
  });
});

describe("fetchPtbBytesPreferCache (panel DB F2)", () => {
  beforeEach(async () => {
    localStorage.clear();
    if (db.isOpen()) await db.close();
    await (await import("dexie")).default.delete("ptn");
    await db.open();
    const { shouldWriteShapes } = await import("./gtfsQuotaGuard.ts");
    (shouldWriteShapes as unknown as { mockReset: () => void; mockResolvedValue: (v: boolean) => void })
      .mockReset();
    (shouldWriteShapes as unknown as { mockResolvedValue: (v: boolean) => void })
      .mockResolvedValue(true);
  });
  afterEach(() => { globalThis.fetch = ORIG_FETCH; });

  it("returns cached bytes WITHOUT a network call when cache exists", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([7]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchPtbBytesPreferCache("vilnius");
    expect(Array.from(result.bytes)).toEqual([7]);
    expect(result.fromCache).toBe(true);
    expect(result.networkValidated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the cached transfer manifest without a network call", async () => {
    const seedAt = Date.now() - 60_000;
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([7]),
      etag: '"v1"',
      firstStoredAt: seedAt,
      lastValidatedAt: seedAt,
      windowDays: 90,
      horizonEndDate: "20260830",
      transfersArtifact: { url: "/api/vilnius/transfers/fetch", hash: "cached", sizeBytes: 9 },
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchPtbBytesPreferCache("vilnius");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.transfersArtifact).toEqual({
      url: "/api/vilnius/transfers/fetch",
      hash: "cached",
      sizeBytes: 9,
    });
  });

  it("falls back to network-first when cache is empty", async () => {
    const bytes = new Uint8Array([5]);
    globalThis.fetch = mockBytes(bytes);
    const result = await fetchPtbBytesPreferCache("vilnius");
    expect(Array.from(result.bytes)).toEqual([5]);
    expect(result.fromCache).toBe(false);
  });

  it("does NOT serve a stale v8 blob after the v8↔v7 cutover wipe evicts the cache (B2 Step 10a rollback-safety)", async () => {
    // End-to-end rollback safety: a device that ran the v8 client cached v8 PTB
    // bytes and was stamped at the higher numeric version. A rolled-back v7
    // client boots; the data-schema guard sees a stamp change and wipes the
    // server-derived cache (incl. ptbBytes). The resume path must then go to
    // NETWORK rather than serving the unsupported v8 blob (which the v7 loader
    // would hard-reject → fail closed forever). See dataSchemaVersion.ts →6.
    const v8Bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00, 8 /* fake v8 marker */]);
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: v8Bytes,
      etag: '"v8"',
      firstStoredAt: Date.now(),
      lastValidatedAt: Date.now(),
      windowDays: 90,
      horizonEndDate: "20260830",
    } as unknown as Parameters<typeof db.ptbBytes.put>[0]);
    localStorage.setItem("ptn:dataSchemaVersion", `${DATA_SCHEMA_VERSION + 1}:off`);

    // The rolled-back client's boot guard wipes the stale v8 cache.
    const guard = await ensureDataSchemaUpToDate(PatternMode.Off);
    expect(guard.kind).toBe("wiped");
    expect(await db.ptbBytes.get("vilnius")).toBeUndefined();

    // Now the prefer-cache resume path finds no row → goes to network for the
    // v7 bundle rather than returning the wiped-away v8 bytes.
    const v7Bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00, 7 /* fake v7 marker */]);
    globalThis.fetch = mockBytes(v7Bytes);
    const result = await fetchPtbBytesPreferCache("vilnius");
    expect(result.fromCache).toBe(false);
    expect(Array.from(result.bytes)).toEqual([0x50, 0x54, 0x42, 0x00, 7]);
  });

  it("dedupes concurrent fetches for the same cityId — only one network call", async () => {

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = mockBytes(bytes);
    globalThis.fetch = fetchSpy;
    const [a, b, c] = await Promise.all([
      fetchPtbBytes("vilnius"),
      fetchPtbBytes("vilnius"),
      fetchPtbBytes("vilnius"),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(false);
    expect(c.fromCache).toBe(false);
    expect(a.bytes).toBe(b.bytes);
    expect(b.bytes).toBe(c.bytes);
  });
});
