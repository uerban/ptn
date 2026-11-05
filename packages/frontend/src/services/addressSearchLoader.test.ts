import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type { AddressSearchArtifactManifest } from "@pt/shared/address-search";
import { db, type AddressSearchArtifactRecord } from "../db/index.ts";
import {
  __resetAddressSearchLoaderForTests,
  syncAddressSearch,
} from "./addressSearchLoader.ts";
import { notifyWriteGrew } from "./storagePolicy.ts";
import { reportError } from "./errorReporter.ts";

vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
  notifyWriteGrew: vi.fn().mockResolvedValue(undefined),
  onQuotaNear: vi.fn().mockResolvedValue([]),
}));

vi.mock("./errorReporter.ts", () => ({
  reportError: vi.fn(),
}));

let fetchSpy: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The loader treats the artifact as OPAQUE BYTES — it verifies size and SHA and
 * stores them, and never parses. So the fixture only has to be recognizable,
 * not a valid PTAS file; whether the bytes are a loadable index is
 * `pt-geocode`'s contract, tested there.
 */
function artifactBody(): string {
  return "PTAS-fixture-bytes";
}

async function manifestFor(body: string): Promise<AddressSearchArtifactManifest> {
  return {
    // Literal on purpose: this is the shipped manifest contract, so the test
    // has to fail if the constant moves under it.
    schemaVersion: 1,
    cityId: "vilnius",
    generatedAt: "2026-08-15T00:00:00.000Z",
    artifactUrl: "/api/vilnius/address-search/bundle",
    sha256: await sha256Hex(body),
    sizeBytes: new TextEncoder().encode(body).byteLength,
    rowCount: 1,
    keyCount: 1,
    bundleGenerationId: "gen-1",
  };
}

function staleRecord(): AddressSearchArtifactRecord {
  const a = artifactBody();
  return {
    cityId: "vilnius",
    sha256: "b".repeat(64),
    sizeBytes: 1,
    generatedAt: "2026-08-15T00:00:00.000Z",
    installedAt: Date.now(),
    rowCount: 1,
    keyCount: 1,
    bytes: new TextEncoder().encode(a).buffer as ArrayBuffer,
  };
}

describe("addressSearchLoader", () => {
  beforeEach(async () => {
    __resetAddressSearchLoaderForTests();
    await db.addressSearchArtifacts.clear();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(notifyWriteGrew).mockClear();
    vi.mocked(reportError).mockClear();
  });

  it("stores a SHA-verified address artifact", async () => {
    const body = artifactBody();
    const manifest = await manifestFor(body);
    fetchSpy.mockImplementation((url: string) => {
      if (url.endsWith("/manifest")) return Promise.resolve(jsonResponse(manifest));
      if (url.endsWith("/bundle")) return Promise.resolve(textResponse(body));
      return Promise.resolve(new Response("", { status: 404 }));
    });

    await expect(syncAddressSearch("vilnius")).resolves.toBe(true);

    const row = await db.addressSearchArtifacts.get("vilnius");
    expect(row).toMatchObject({
      cityId: "vilnius",
      sha256: manifest.sha256,
      rowCount: 1,
      keyCount: 1,
      bundleGenerationId: "gen-1",
    });
    expect(new TextDecoder().decode(row?.bytes)).toBe(body);
    expect(notifyWriteGrew).toHaveBeenCalledTimes(1);
  });

  it("refuses a manifest advertising any other schema version", async () => {
    // There is no compatibility reader, so an unrecognized version must stop
    // the sync before the bundle is fetched — not download bytes the index
    // cannot read.
    const manifest = { ...(await manifestFor(artifactBody())), schemaVersion: 2 };
    fetchSpy.mockImplementation((url: string) => {
      if (url.endsWith("/manifest")) return Promise.resolve(jsonResponse(manifest));
      return Promise.resolve(textResponse(artifactBody()));
    });

    await expect(syncAddressSearch("vilnius")).resolves.toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(db.addressSearchArtifacts.get("vilnius")).resolves.toBeUndefined();
    const reported = vi.mocked(reportError).mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported?.message).toBe("unsupported address-search manifest schema 2");
  });

  it("clears a stale cached artifact when the manifest is 404", async () => {
    await db.addressSearchArtifacts.put(staleRecord());
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));

    await expect(syncAddressSearch("vilnius")).resolves.toBe(false);

    await expect(db.addressSearchArtifacts.get("vilnius")).resolves.toBeUndefined();
  });
});
