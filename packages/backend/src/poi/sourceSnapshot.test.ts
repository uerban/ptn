import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { inspectPbf, refreshSnapshot } from "./sourceSnapshot.js";

describe("immutable PBF snapshots", () => {
  it.runIf(spawnSync("osmium", ["--version"], { timeout: 1000 }).status === 0)("reads the real PBF timestamp from a download staging filename", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ptn-pbf-header-"));
    try {
      const xml = join(cache, "source.osm"); const staged = join(cache, "download.part");
      await writeFile(xml, '<osm version="0.6"><node id="1" version="1" lat="1" lon="1"/></osm>');
      const generated = spawnSync("osmium", ["cat", xml, "-f", "pbf", "-o", staged, "--output-header=osmosis_replication_timestamp=2026-10-28T00:00:00Z"], { encoding: "utf8", timeout: 10000 });
      expect(generated.status, generated.stderr).toBe(0);
      expect(inspectPbf(staged)).toBe("2026-10-28T00:00:00.000Z");
    } finally { await rm(cache, { recursive: true, force: true }); }
  });

  it("revalidates warm sources, preserves source time and freezes changed bytes", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ptn-snapshot-"));
    try {
      const requests: RequestInit[] = [];
      const responses = [new Response("first", { headers: { ETag: '"v1"' } }), new Response(null, { status: 304 }), new Response("second", { headers: { ETag: '"v2"' } })];
      const fetcher = (async (_url, init) => { requests.push(init!); return responses.shift()!; }) as typeof fetch;
      const opts = { fetch: fetcher, now: () => new Date("2026-10-30T00:00:00Z"), inspect: () => "2026-10-28T00:00:00Z" };
      const first = await refreshSnapshot("https://example.org/source.pbf", cache, opts);
      const unchanged = await refreshSnapshot(first.url, cache, opts);
      const changed = await refreshSnapshot(first.url, cache, opts);
      expect((requests[1].headers as Record<string, string>)["If-None-Match"]).toBe('"v1"');
      expect(unchanged.sha256).toBe(first.sha256);
      expect(unchanged.snapshotAt).toBe("2026-10-28T00:00:00.000Z");
      expect(changed.sha256).not.toBe(first.sha256);
      expect(await readFile(first.path, "utf8")).toBe("first");
      expect(await readFile(changed.path, "utf8")).toBe("second");
    } finally { await rm(cache, { recursive: true, force: true }); }
  });

  it("forces a full refresh after the bound and retains last-good on failure", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ptn-snapshot-"));
    try {
      const url = "https://example.org/source.pbf";
      const first = await refreshSnapshot(url, cache, { fetch: (async () => new Response("first", { headers: { ETag: '"v1"' } })) as typeof fetch, now: () => new Date("2026-10-20"), inspect: () => "2026-10-19" });
      const before = await readFile(join(cache, "sources/urls", (await readdir(join(cache, "sources/urls")))[0]), "utf8");
      await expect(refreshSnapshot(url, cache, { now: () => new Date("2026-10-30"), fetch: (async (_url, init) => {
        expect((init?.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
        return new Response("unavailable", { status: 503 });
      }) as typeof fetch })).rejects.toThrow("503");
      expect(await readFile(first.path, "utf8")).toBe("first");
      expect(await readFile(join(cache, "sources/urls", (await readdir(join(cache, "sources/urls")))[0]), "utf8")).toBe(before);
      await expect(refreshSnapshot(url, cache, { maxBytes: 2, fetch: (async () => new Response("oversized")) as typeof fetch })).rejects.toThrow("size limit");
      expect((await readdir(join(cache, "sources/sha256"))).some((name) => name.endsWith(".part"))).toBe(false);
    } finally { await rm(cache, { recursive: true, force: true }); }
  });
  // Large regional extracts can take longer than any fixed total limit, so the
  // download is bounded by inactivity instead.
  const trickle = (chunks: number, everyMs: number, thenStall = false) => new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks; i++) { controller.enqueue(new Uint8Array([i])); await new Promise((r) => setTimeout(r, everyMs)); }
      if (!thenStall) controller.close();
    },
  });

  it("keeps a slow download that never stalls", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ptn-pbf-slow-"));
    try {
      const snapshot = await refreshSnapshot("https://example.test/slow.osm.pbf", cache, {
        stallTimeoutMs: 100, inspect: () => "2026-10-28T00:00:00Z",
        fetch: (async () => new Response(trickle(8, 40))) as typeof fetch,
      });
      expect(snapshot.bytes).toBe(8);
    } finally { await rm(cache, { recursive: true, force: true }); }
  });

  it("aborts a download that stops sending bytes", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ptn-pbf-stall-"));
    try {
      await expect(refreshSnapshot("https://example.test/stall.osm.pbf", cache, {
        stallTimeoutMs: 100, inspect: () => "2026-10-28T00:00:00Z",
        fetch: (async () => new Response(trickle(1, 0, true))) as typeof fetch,
      })).rejects.toThrow(/stalled/);
      expect((await readdir(join(cache, "sources", "sha256"))).filter((f) => f.endsWith(".part"))).toEqual([]);
    } finally { await rm(cache, { recursive: true, force: true }); }
  }, 5000);

  it("follows same-origin HTTPS redirects to dated extracts and refuses others", async () => {
    const cache = await mkdtemp(join(tmpdir(), "ptn-snapshot-"));
    try {
      const urls: string[] = [];
      const redirect = (location: string) => new Response(null, { status: 307, headers: { Location: location } });
      const serve = (responses: Response[]) => (async (url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual"); urls.push(url); return responses.shift()!;
      }) as typeof fetch;
      const opts = { now: () => new Date("2026-10-30T00:00:00Z"), inspect: () => "2026-10-28T00:00:00Z" };
      const latest = "https://example.org/europe/x-latest.osm.pbf";
      const ok = await refreshSnapshot(latest, cache, { ...opts, fetch: serve([redirect("x-261031.osm.pbf"), new Response("data")]) });
      expect(urls).toEqual([latest, "https://example.org/europe/x-261031.osm.pbf"]);
      expect(ok.url).toBe(latest);
      expect(await readFile(ok.path, "utf8")).toBe("data");
      for (const location of ["https://evil.example/x.pbf", "http://example.org/x.pbf"])
        await expect(refreshSnapshot(latest, cache, { ...opts, now: () => new Date("2026-12-30"), fetch: serve([redirect(location)]) })).rejects.toThrow(/redirect/);
      await expect(refreshSnapshot(latest, cache, { ...opts, now: () => new Date("2026-12-30"), fetch: serve(Array.from({ length: 5 }, () => redirect("loop.pbf"))) })).rejects.toThrow(/redirect/);
    } finally { await rm(cache, { recursive: true, force: true }); }
  });
});
