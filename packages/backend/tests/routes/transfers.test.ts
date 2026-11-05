import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { encode } from "@pt/shared";
import { TransfersStore } from "../../src/gtfs/transfersStore.js";
import { GtfsStore } from "../../src/gtfs/store.js";
import { registerTransfersRoute } from "../../src/routes/transfers.js";

/**
 * Build a small valid PTFT artifact for tests. Two stops, one edge.
 * Bytes-stable across runs so we can assert on hash if needed.
 */
function makeTransfersBytes(): Uint8Array {
  return encode(
    ["A", "B"],
    [
      [{ neighborIdx: 1, walkSecs: 60 }],
      [{ neighborIdx: 0, walkSecs: 60 }],
    ],
  );
}

function writeTransfersFile(dataDir: string, cityId: string, variant: string, bytes: Uint8Array): string {
  const dir = path.join(dataDir, "transfers", cityId, variant);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "transfers.bin");
  writeFileSync(file, bytes);
  return file;
}

describe("TransfersStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ptn-transfers-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports absent when the file does not exist", () => {
    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    expect(store.isPresent()).toBe(false);
    expect(store.getArtifactMeta()).toBeNull();
    expect(store.getBytes()).toBeNull();
    expect(store.getGzipBytes()).toBeNull();
  });

  it("loads the file and exposes hash + size + bytes when present", () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    expect(store.isPresent()).toBe(true);
    expect(store.getSizeBytes()).toBe(bytes.length);
    expect(store.getHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getBytes()?.length).toBe(bytes.length);

    const meta = store.getArtifactMeta();
    expect(meta).not.toBeNull();
    expect(meta!.url).toBe("/api/vilnius/transfers/fetch");
    expect(meta!.sizeBytes).toBe(bytes.length);
    expect(meta!.hash).toBe(store.getHash());
  });

  it("uses sha256 of the raw bytes as the hash", () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    expect(store.getHash()).toBe(expected);
  });

  it("reloads on mtime change", () => {
    const firstBytes = makeTransfersBytes();
    const file = writeTransfersFile(dataDir, "vilnius", "pedestrian-only", firstBytes);

    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    const firstHash = store.getHash();

    // Rewrite with different contents. Bump mtime explicitly so we don't depend
    // on filesystem mtime granularity (some FSes round to whole seconds).
    const secondBytes = encode(
      ["A", "B", "C"],
      [
        [{ neighborIdx: 1, walkSecs: 30 }],
        [{ neighborIdx: 0, walkSecs: 30 }],
        [],
      ],
    );
    writeFileSync(file, secondBytes);
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);

    const secondHash = store.getHash();
    expect(secondHash).not.toBe(firstHash);
    expect(store.getSizeBytes()).toBe(secondBytes.length);
  });

  it("degrades to absent when a previously present file is removed", () => {
    const bytes = makeTransfersBytes();
    const file = writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    expect(store.isPresent()).toBe(true);

    unlinkSync(file);
    expect(store.isPresent()).toBe(false);
    expect(store.getBytes()).toBeNull();
    expect(store.getGzipBytes()).toBeNull();
    expect(store.getArtifactMeta()).toBeNull();
  });

  it("getSnapshot returns the same hash and bytes from a single reload", () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    const snap = store.getSnapshot();
    expect(snap).not.toBeNull();
    // hash must equal sha256 of bytes (independent of internal calls).
    const expectedHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    expect(snap!.hash).toBe(expectedHash);
    expect(snap!.bytes.equals(Buffer.from(bytes))).toBe(true);
    // gzipBytes must round-trip to the original bytes.
    expect(gunzipSync(snap!.gzipBytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("getSnapshot returns null when the file is absent", () => {
    const store = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    expect(store.getSnapshot()).toBeNull();
  });
});

describe("GET /api/transfers/fetch", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ptn-transfers-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns 404 when no transfers store is attached", async () => {
    const app = Fastify();
    const gtfs = new GtfsStore();
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", gtfs);
    registerTransfersRoute(app);

    const res = await app.inject({ method: "GET", url: "/api/transfers/fetch" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the artifact file is absent", async () => {
    const app = Fastify();
    const gtfs = new GtfsStore();
    gtfs.setTransfersStore(new TransfersStore("vilnius", "pedestrian-only", dataDir));
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", gtfs);
    registerTransfersRoute(app);

    const res = await app.inject({ method: "GET", url: "/api/transfers/fetch" });
    expect(res.statusCode).toBe(404);
  });

  it("serves uncompressed bytes by default with ETag and Cache-Control", async () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const app = Fastify();
    const gtfs = new GtfsStore();
    const transfers = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    gtfs.setTransfersStore(transfers);
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", gtfs);
    registerTransfersRoute(app);

    const res = await app.inject({ method: "GET", url: "/api/transfers/fetch" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["cache-control"]).toMatch(/max-age=300/);
    expect(res.headers.vary).toMatch(/accept-encoding/i);
    expect(res.headers.etag).toBe(`"${transfers.getHash()}"`);
    expect(res.rawPayload.length).toBe(bytes.length);
    expect(Buffer.from(res.rawPayload).equals(Buffer.from(bytes))).toBe(true);
  });

  it("serves gzip when Accept-Encoding includes gzip", async () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const app = Fastify();
    const gtfs = new GtfsStore();
    gtfs.setTransfersStore(new TransfersStore("vilnius", "pedestrian-only", dataDir));
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", gtfs);
    registerTransfersRoute(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/transfers/fetch",
      headers: { "accept-encoding": "gzip, deflate" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    // Round-trip: decompressed payload must equal the original artifact bytes.
    const decoded = gunzipSync(res.rawPayload);
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
  });

  it("returns 304 on If-None-Match matching the artifact hash", async () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const app = Fastify();
    const gtfs = new GtfsStore();
    const transfers = new TransfersStore("vilnius", "pedestrian-only", dataDir);
    gtfs.setTransfersStore(transfers);
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", gtfs);
    registerTransfersRoute(app);

    const etag = `"${transfers.getHash()}"`;
    const res = await app.inject({
      method: "GET",
      url: "/api/transfers/fetch",
      headers: { "if-none-match": etag },
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers.etag).toBe(etag);
    expect(res.headers.vary).toMatch(/accept-encoding/i);
    expect(res.rawPayload.length).toBe(0);
  });

  it("serves fresh bytes when If-None-Match does NOT match", async () => {
    const bytes = makeTransfersBytes();
    writeTransfersFile(dataDir, "vilnius", "pedestrian-only", bytes);

    const app = Fastify();
    const gtfs = new GtfsStore();
    gtfs.setTransfersStore(new TransfersStore("vilnius", "pedestrian-only", dataDir));
    // @ts-expect-error attach for test
    app.decorate("gtfsStore", gtfs);
    registerTransfersRoute(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/transfers/fetch",
      headers: { "if-none-match": '"stale-hash"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(bytes.length);
  });
});
