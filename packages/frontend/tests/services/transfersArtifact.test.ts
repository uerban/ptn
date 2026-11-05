import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { encode } from "@pt/shared";
import { fetchTransfersArtifact } from "../../src/services/transfersArtifact.ts";

const URL = "/api/vilnius/transfers/fetch";

function makeArtifact(): { bytes: Uint8Array; hash: string } {
  const bytes = encode(
    ["A", "B"],
    [
      [{ neighborIdx: 1, walkSecs: 60 }],
      [{ neighborIdx: 0, walkSecs: 60 }],
    ],
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash };
}

function mockFetch(impl: typeof fetch): void {
  vi.stubGlobal("fetch", impl);
}

describe("fetchTransfersArtifact", () => {
  beforeEach(() => {
    // jsdom doesn't supply window.location at module init for some test
    // configs — pin a known origin so the URL resolution is deterministic.
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the decoded transfers on a 200 with matching hash", async () => {
    const { bytes, hash } = makeArtifact();
    mockFetch(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );

    const decoded = await fetchTransfersArtifact(URL, hash);
    expect(decoded.stopIds).toEqual(["A", "B"]);
    expect(decoded.adj.offsets.length).toBe(3);
    expect(Array.from(decoded.adj.walkSecs)).toEqual([60, 60]);
  });

  it("throws on HTTP non-2xx", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));

    await expect(fetchTransfersArtifact(URL, "deadbeef")).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("throws on hash mismatch", async () => {
    const { bytes } = makeArtifact();
    mockFetch(async () => new Response(bytes, { status: 200 }));

    await expect(
      fetchTransfersArtifact(URL, "0".repeat(64)),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("throws when the bytes don't decode as a PTFT artifact", async () => {
    // Random bytes that won't pass the magic-prefix check.
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const hash = createHash("sha256").update(garbage).digest("hex");
    mockFetch(async () => new Response(garbage, { status: 200 }));

    await expect(fetchTransfersArtifact(URL, hash)).rejects.toThrow();
  });
});
