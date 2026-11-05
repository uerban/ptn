import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BundleManifest } from "@pt/shared";

// Mock cityStore so getBaseUrl() returns a predictable value
vi.mock("../stores/cityStore.ts", () => ({
  useCityStore: {
    getState: () => ({ getApiUrl: () => "/api/vilnius" }),
  },
}));

// Spy on reportTelemetry
const reportTelemetrySpy = vi.fn();
vi.mock("./errorReporter.ts", () => ({
  reportTelemetry: (...args: unknown[]) => reportTelemetrySpy(...args),
  reportError: vi.fn(),
  getErrorBuffer: vi.fn(() => []),
  clearErrorBuffer: vi.fn(),
  installGlobalHandlers: vi.fn(),
}));

function makeManifest(overrides: Partial<BundleManifest> = {}): BundleManifest {
  return {
    schemaVersion: 1,
    bundleHash: "deadbeef",
    generatedAt: 1700000000000,
    tileSize: 6000,
    ...overrides,
  };
}

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const headersObj = new Headers(headers);
  const bodyStr = body instanceof ArrayBuffer ? body : JSON.stringify(body);
  return new Response(bodyStr as BodyInit, { status, headers: headersObj });
}

function makeArrayBufferResponse(
  status: number,
  bytes: ArrayBuffer,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, { status, headers: new Headers(headers) });
}

describe("fetchManifest", () => {
  beforeEach(() => {
    reportTelemetrySpy.mockClear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200: parses manifest, returns etag + bundleHash, fromCache=false, no If-None-Match sent", async () => {
    const M = makeManifest();
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse(200, M, {
        "X-PT-Bundle-Hash": "abc",
        ETag: '"e1"',
        "Content-Type": "application/json",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchManifest } = await import("./api.ts");
    const result = await fetchManifest();

    expect(result.manifest).toEqual(M);
    expect(result.etag).toBe('"e1"');
    expect(result.bundleHash).toBe("abc");
    expect(result.fromCache).toBe(false);

    // Must NOT have sent If-None-Match on a cold (no cached arg) request
    const callHeaders = fetchMock.mock.calls[0][1]?.headers as Headers | undefined;
    if (callHeaders instanceof Headers) {
      expect(callHeaders.has("If-None-Match")).toBe(false);
    } else if (callHeaders && typeof callHeaders === "object") {
      expect((callHeaders as Record<string, string>)["If-None-Match"]).toBeUndefined();
    }
  });

  it("304: returns cached manifest with fromCache=true, If-None-Match sent", async () => {
    const M = makeManifest();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: new Headers({ "X-PT-Bundle-Hash": "abc" }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchManifest } = await import("./api.ts");
    const result = await fetchManifest({ manifest: M, etag: '"e1"' });

    expect(result.manifest).toEqual(M);
    expect(result.etag).toBe('"e1"');
    expect(result.fromCache).toBe(true);

    // Must have sent If-None-Match
    const callHeaders = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(callHeaders.get("If-None-Match")).toBe('"e1"');
  });

  it("503 with cache: returns cached manifest, fromCache=true, calls reportTelemetry", async () => {
    const M = makeManifest();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const { fetchManifest } = await import("./api.ts");
    const result = await fetchManifest({ manifest: M, etag: '"e1"' });

    expect(result.manifest).toEqual(M);
    expect(result.fromCache).toBe(true);
    // Must NOT be an empty subdivisions-only manifest
    expect(result.manifest.bundleHash).toBe("deadbeef");
    expect(reportTelemetrySpy).toHaveBeenCalledWith("manifest_unavailable_reused_cache", { status: 503 });
  });

  it("503 cold start (no cache): throws ManifestUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const { fetchManifest, ManifestUnavailableError } = await import("./api.ts");
    await expect(fetchManifest()).rejects.toBeInstanceOf(ManifestUnavailableError);
  });
});

describe("fetchScheduleTile", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200: returns ArrayBuffer bytes + bundleHash, no If-None-Match sent", async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue(
      makeArrayBufferResponse(200, buf, { "X-PT-Bundle-Hash": "hashval" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchScheduleTile } = await import("./api.ts");
    const result = await fetchScheduleTile("hashval", "6000", "1_2");

    expect(result.status).toBe(200);
    expect(result.bytes).toBeInstanceOf(ArrayBuffer);
    expect(result.bundleHash).toBe("hashval");

    // Must NOT send If-None-Match
    const callHeaders = fetchMock.mock.calls[0][1]?.headers as Headers | undefined;
    if (callHeaders instanceof Headers) {
      expect(callHeaders.has("If-None-Match")).toBe(false);
    } else {
      // no headers object sent at all is also fine
      expect(callHeaders).toBeUndefined();
    }
  });

  it("409: returns { status: 409, bundleHash }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 409,
          headers: new Headers({ "X-PT-Bundle-Hash": "newhash" }),
        }),
      ),
    );

    const { fetchScheduleTile } = await import("./api.ts");
    const result = await fetchScheduleTile("oldhash", "6000", "1_2");

    expect(result.status).toBe(409);
    expect(result.bundleHash).toBe("newhash");
    expect(result.bytes).toBeUndefined();
  });

  it("429: returns { status: 429, bundleHash }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: new Headers({ "X-PT-Bundle-Hash": "h" }),
        }),
      ),
    );

    const { fetchScheduleTile } = await import("./api.ts");
    const result = await fetchScheduleTile("h", "6000", "1_2");

    expect(result.status).toBe(429);
    expect(result.bundleHash).toBe("h");
  });

  it("404 tile_subdivided: returns { status: 404, leaves, bundleHash }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "tile_subdivided", leaves: ["0", "3-1"] }), {
          status: 404,
          headers: new Headers({
            "Content-Type": "application/json",
            "X-PT-Bundle-Hash": "h2",
          }),
        }),
      ),
    );

    const { fetchScheduleTile } = await import("./api.ts");
    const result = await fetchScheduleTile("h2", "6000", "1_2");

    expect(result.status).toBe(404);
    expect(result.leaves).toEqual(["0", "3-1"]);
    expect(result.bundleHash).toBe("h2");
  });

  it("404 tile_not_found: returns { status: 404 } without leaves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "tile_not_found" }), {
          status: 404,
          headers: new Headers({ "Content-Type": "application/json" }),
        }),
      ),
    );

    const { fetchScheduleTile } = await import("./api.ts");
    const result = await fetchScheduleTile("h3", "6000", "1_2");

    expect(result.status).toBe(404);
    expect(result.leaves).toBeUndefined();
  });
});

describe("fetchRtTile", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200: returns { status: 200, body } with the parsed RtTileResponse", async () => {
    const body = { bundleHash: "h1", generatedAt: 1700000000000, trips: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
        }),
      ),
    );

    const { fetchRtTile } = await import("./api.ts");
    const result = await fetchRtTile("h1", "6km", "1_2");

    expect(result.status).toBe(200);
    expect(result.body).toEqual(body);
  });

  it("409: returns { status: 409 } without body, does not throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 409 })),
    );

    const { fetchRtTile } = await import("./api.ts");
    const result = await fetchRtTile("h1", "6km", "1_2");

    expect(result.status).toBe(409);
    expect(result.body).toBeUndefined();
  });

  it("network throw: returns { status: 0 } without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network error")),
    );

    const { fetchRtTile } = await import("./api.ts");
    const result = await fetchRtTile("h1", "6km", "1_2");

    expect(result.status).toBe(0);
    expect(result.body).toBeUndefined();
  });

  it("fetches the correct URL: /gtfs/rt-tile/<hash>/<size>/<coords>", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bundleHash: "h1", generatedAt: 0, trips: [] }), {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchRtTile } = await import("./api.ts");
    await fetchRtTile("myhash", "6km", "28_906-1");

    const calledUrl: string = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/gtfs/rt-tile/myhash/6km/28_906-1");
  });
});
