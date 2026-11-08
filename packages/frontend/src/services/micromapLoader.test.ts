import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import {
  getMicromapState,
  loadMicromap,
  micromapUrl,
  MICROMAP_CACHE,
  resetMicromapCache,
  subscribeMicromapState,
} from "./micromapLoader.ts";

// The artifact is stored brotli-compressed; the tests hand the loader plain
// UTF-8 bytes and stub the decompression step. Kept as a spy so the
// "already decompressed by a proxy" path can prove it never runs.
const decompressBrotli = vi.hoisted(() =>
  vi.fn(async (buffer: ArrayBuffer) =>
    new TextDecoder().decode(new Uint8Array(buffer)),
  ),
);
vi.mock("./brotliDecode.ts", () => ({ decompressBrotli }));

const reportError = vi.fn();
vi.mock("./errorReporter.ts", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

const ARTIFACT = {
  version: 1,
  cityId: "vilnius",
  generatedAt: "2026-08-20",
  attribution: "© OpenStreetMap contributors (ODbL)",
  bbox: [25.15, 54.62, 25.42, 54.75],
  water: [],
  green: [],
  waterways: [],
  roads: [{ c: "primary", g: "_rzlI_{xxC?o}@" }],
  places: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(new TextEncoder().encode(JSON.stringify(body)), {
    status,
  });
}

beforeEach(() => {
  resetMicromapCache();
  reportError.mockClear();
  decompressBrotli.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadMicromap", () => {
  test("fetches, decodes and validates the artifact", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ARTIFACT));
    vi.stubGlobal("fetch", fetchMock);

    const artifact = await loadMicromap("vilnius");

    expect(fetchMock).toHaveBeenCalledWith(micromapUrl("vilnius"));
    expect(artifact?.cityId).toBe("vilnius");
    expect(artifact?.roads).toHaveLength(1);
  });

  test("accepts a body a proxy already decompressed for us", async () => {
    // vite's dev server (and CDNs that infer an encoding from `.br`) send
    // `Content-Encoding: br`, so fetch hands back plain JSON. Decompressing
    // that a second time used to fail and blank the micromap — so the
    // decompressor is made to throw here: the load must not reach it.
    decompressBrotli.mockRejectedValueOnce(new Error("not a brotli stream"));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ARTIFACT)));

    const artifact = await loadMicromap("vilnius");

    expect(artifact?.cityId).toBe("vilnius");
    expect(decompressBrotli).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  test("memoizes per city, including the 404", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadMicromap("krakow")).toBeNull();
    expect(await loadMicromap("krakow")).toBeNull();

    // A city with no artifact must not be re-requested on every pan.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  test("shares one in-flight request between concurrent callers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ARTIFACT));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      loadMicromap("vilnius"),
      loadMicromap("vilnius"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  test("refuses another city's artifact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...ARTIFACT, cityId: "tricity" })),
    );

    expect(await loadMicromap("vilnius")).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  test("refuses an artifact from an unknown format version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...ARTIFACT, version: 2 })),
    );

    expect(await loadMicromap("vilnius")).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  test("survives a network failure without caching the miss", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse(ARTIFACT));
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadMicromap("vilnius")).toBeNull();
    expect(await loadMicromap("vilnius")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("micromap state", () => {
  test("is loading while the request is out, then ready", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((r) => (resolve = r))),
    );
    const seen: (string | undefined)[] = [];
    const stop = subscribeMicromapState(() => seen.push(getMicromapState("vilnius")));

    const load = loadMicromap("vilnius");
    expect(getMicromapState("vilnius")).toBe("loading");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve(jsonResponse(ARTIFACT));
    await load;

    expect(getMicromapState("vilnius")).toBe("ready");
    expect(seen).toEqual(["loading", "ready"]);
    stop();
  });

  test("reports a city without an artifact as absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await loadMicromap("krakow");
    expect(getMicromapState("krakow")).toBe("absent");
  });

  test("tells a copy already on this device apart from a network load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ARTIFACT)));
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === MICROMAP_CACHE),
      open: vi.fn(async () => ({
        match: vi.fn(async (url: string) =>
          url === micromapUrl("vilnius") ? new Response("cached") : undefined,
        ),
      })),
    });
    await loadMicromap("vilnius");
    expect(getMicromapState("vilnius")).toBe("cached");
  });

  test("separates an offline miss from a failure, and only reports the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    vi.stubGlobal("navigator", { onLine: false });
    await loadMicromap("vilnius");
    expect(getMicromapState("vilnius")).toBe("offline");
    expect(reportError).not.toHaveBeenCalled();

    vi.stubGlobal("navigator", { onLine: true });
    await loadMicromap("vilnius");
    expect(getMicromapState("vilnius")).toBe("failed");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
