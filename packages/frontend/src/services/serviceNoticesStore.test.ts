import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type { ServiceNoticesBody } from "@pt/shared";
import { db } from "../db/index.ts";
import {
  clearServiceNotices,
  loadServiceNotices,
  readNoticesArtifactHeaders,
  syncServiceNotices,
  useServiceNoticesStore,
} from "./serviceNoticesStore.ts";

const BODY: ServiceNoticesBody = {
  schemaVersion: 1,
  notices: [{
    id: "vilnius-2026-christmas-bus", routeIds: ["201"], kind: "seasonal", free: true,
    windows: [{ start: "2026-11-27T22:00:00Z", end: "2026-12-31T22:00:00Z" }],
    displayUntil: "2026-12-31", icon: "🎄", source: "https://example.org/christmas",
  }],
};
const BYTES = new TextEncoder().encode(JSON.stringify(BODY) + "\n");

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function artifact(bytes = BYTES) {
  return { url: "/api/vilnius/notices/fetch", hash: await sha256(bytes), sizeBytes: bytes.byteLength };
}

describe("serviceNoticesStore", () => {
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    await db.serviceNotices.clear();
    useServiceNoticesStore.setState({ byCity: {} });
    fetchSpy = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(BYTES.slice(), { status: 200 })));
  });

  it("parses the three headers into a manifest and ignores partial ones", () => {
    const headers = new Headers({
      "X-PT-Notices-Artifact-Url": "/api/vilnius/notices/fetch",
      "X-PT-Notices-Artifact-Hash": "a".repeat(64),
      "X-PT-Notices-Artifact-Size": "120",
    });
    expect(readNoticesArtifactHeaders(headers)).toEqual({ url: "/api/vilnius/notices/fetch", hash: "a".repeat(64), sizeBytes: 120 });
    headers.delete("X-PT-Notices-Artifact-Size");
    expect(readNoticesArtifactHeaders(headers)).toBeUndefined();
    expect(readNoticesArtifactHeaders(new Headers({
      "X-PT-Notices-Artifact-Url": "/x", "X-PT-Notices-Artifact-Hash": "a", "X-PT-Notices-Artifact-Size": "-1",
    }))).toBeUndefined();
  });

  it("fetches a new generation's notices, stores them and publishes them", async () => {
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    expect(fetchSpy).toHaveBeenCalledWith("/api/vilnius/notices/fetch", expect.anything());
    expect((await db.serviceNotices.get("vilnius"))?.notices).toEqual(BODY.notices);
    expect(useServiceNoticesStore.getState().byCity.vilnius).toEqual(BODY.notices);
  });

  it("does not refetch the same hash", async () => {
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("no header means no request and clears what was stored", async () => {
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    await syncServiceNotices("vilnius", undefined, fetchSpy);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await db.serviceNotices.get("vilnius")).toBeUndefined();
    expect(useServiceNoticesStore.getState().byCity.vilnius).toEqual([]);
  });

  it("a failed or mismatched fetch never throws and keeps the stored row", async () => {
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    const other = { ...(await artifact()), hash: "b".repeat(64) };
    await expect(syncServiceNotices("vilnius", other, failing)).resolves.toBeUndefined();
    const wrongBytes = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(syncServiceNotices("vilnius", other, wrongBytes)).resolves.toBeUndefined();
    expect((await db.serviceNotices.get("vilnius"))?.notices).toEqual(BODY.notices);
  });

  it("rejects a body of an unknown schema", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, notices: [] }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes.slice(), { status: 200 }));
    await syncServiceNotices("vilnius", await artifact(bytes), fetcher);
    expect(await db.serviceNotices.get("vilnius")).toBeUndefined();
  });

  it("the stored row survives offline and loads into the store", async () => {
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    useServiceNoticesStore.setState({ byCity: {} });
    expect(await loadServiceNotices("vilnius")).toEqual(BODY.notices);
    expect(useServiceNoticesStore.getState().byCity.vilnius).toEqual(BODY.notices);
    expect(await loadServiceNotices("riga")).toEqual([]);
  });

  it("clears one city or all", async () => {
    await syncServiceNotices("vilnius", await artifact(), fetchSpy);
    await syncServiceNotices("riga", { ...(await artifact()), url: "/api/riga/notices/fetch" }, fetchSpy);
    await clearServiceNotices("vilnius");
    expect(await db.serviceNotices.get("vilnius")).toBeUndefined();
    expect(await db.serviceNotices.get("riga")).toBeDefined();
    await clearServiceNotices();
    expect(await db.serviceNotices.count()).toBe(0);
    expect(useServiceNoticesStore.getState().byCity).toEqual({});
  });
});
