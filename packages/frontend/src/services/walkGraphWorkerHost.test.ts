import {fixtureGraphArtifacts} from "./walkGraphFixtureArtifacts.ts";
import { describe, it, expect, vi } from "vitest";
import { createWalkGraphHost, type WalkGraphHostDeps, type WalkGraphReply } from "./walkGraphWorkerHost.ts";
import type { WalkRoute } from "./walkGraphClient.ts";

const ROUTE: WalkRoute = { coords: [[25.28, 54.68]], distanceMeters: 0, steps: [] };
const MAGIC = [0x50, 0x54, 0x57, 0x47];

/** A body that names its city after the magic; the fake graph reads it back. */
const body = (city: string) => new Uint8Array([...MAGIC, ...new TextEncoder().encode(city)]);
const cityOf = (url: string) => /walk-graph\/(\w+)\./.exec(url)![1]!;

function setup(fetchImpl?: WalkGraphHostDeps["fetch"]) {
  const log: string[] = [];
  const fetchMock = vi.fn(fetchImpl ?? (async (url: string | URL | Request) => new Response(body(cityOf(String(url))))));
  const host = createWalkGraphHost({
    fetch: fetchMock as unknown as typeof fetch,
    artifacts: fixtureGraphArtifacts(fetchMock as unknown as typeof fetch),
    decompress: vi.fn(async () => { throw new Error("not brotli"); }),
    loadModule: async () => ({
      PtWalkGraph: function (bytes: Uint8Array) {
        const city = new TextDecoder().decode(bytes.subarray(4));
        log.push(`new ${city}`);
        return {
          cityId: () => city,
          route: vi.fn(() => ROUTE),
          free: () => log.push(`free ${city}`),
        };
      } as never,
      default: async () => undefined,
    }),
  });
  let id = 0;
  const load = (cityId: string) => host.handle({ id: id++, op: "load", cityId });
  const route = (cityId: string) =>
    host.handle({ id: id++, op: "route", cityId, from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, profile: "default" });
  return { host, log, fetchMock, load, route };
}

const status = (r: WalkGraphReply) => (r.op === "load" ? r.status : r.op);

describe("walkGraphWorkerHost", () => {
  it("frees the old city's graph before building the next", async () => {
    const s = setup();
    expect(await s.load("vilnius")).toMatchObject({ status: "ready", loadedCity: "vilnius" });
    expect(await s.load("tricity")).toMatchObject({ status: "ready", loadedCity: "tricity" });
    expect(s.log).toEqual(["new vilnius", "free vilnius", "new tricity"]);
  });

  it("answers a repeat load of the held city without fetching", async () => {
    const s = setup();
    await s.load("vilnius");
    expect(status(await s.load("vilnius"))).toBe("ready");
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an overtaken load's fetch and answers superseded", async () => {
    let aborted = false;
    const s = setup(async (url, init) => {
      const city = cityOf(String(url));
      if (city === "vilnius") {
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }));
      }
      return new Response(body(city));
    });
    const first = s.load("vilnius");
    await vi.waitFor(() => expect(s.fetchMock).toHaveBeenCalledTimes(1));
    const second = s.load("tricity");
    expect(await first).toMatchObject({ status: "superseded", loadedCity: null });
    expect(aborted).toBe(true);
    expect(await second).toMatchObject({ status: "ready", loadedCity: "tricity" });
    expect(s.log).toEqual(["new tricity"]);
  });

  it("tags failures: 404 missing, HTML missing, 5xx transient, network transient, bad bytes", async () => {
    const answer = vi.fn<() => Promise<Response>>();
    const s = setup(() => answer());
    answer.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(status(await s.load("a"))).toBe("missing");
    answer.mockResolvedValueOnce(new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect(status(await s.load("a"))).toBe("missing");
    answer.mockResolvedValueOnce(new Response(null, { status: 502 }));
    expect(await s.load("a")).toMatchObject({ status: "transient", detail: "walk graph HTTP 502" });
    answer.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await s.load("a")).toMatchObject({ status: "transient", network: true });
    answer.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    expect(await s.load("a")).toMatchObject({ status: "bad", detail: expect.stringContaining("not brotli") });
    answer.mockResolvedValueOnce(new Response(body("tricity")));
    expect(await s.load("vilnius")).toMatchObject({ status: "bad", loadedCity: null });
    expect(s.log).toEqual(["new tricity", "free tricity"]);
  });

  it("routes only on the held city", async () => {
    const s = setup();
    await s.load("vilnius");
    expect(await s.route("vilnius")).toMatchObject({ route: ROUTE, loadedCity: "vilnius" });
    expect(await s.route("tricity")).toMatchObject({ route: null, loadedCity: "vilnius" });
  });

  it("dispose frees the graph and supersedes a load in flight", async () => {
    const s = setup(async (url, init) => {
      const city = cityOf(String(url));
      if (city === "tricity") {
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return new Response(body(city));
    });
    await s.load("vilnius");
    const pending = s.load("tricity");
    await vi.waitFor(() => expect(s.fetchMock).toHaveBeenCalledTimes(2));
    s.host.dispose();
    expect(await pending).toMatchObject({ status: "superseded", loadedCity: null });
    expect(s.log).toEqual(["new vilnius", "free vilnius"]);
  });
});
