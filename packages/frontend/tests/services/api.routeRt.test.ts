import { afterEach, expect, it, vi } from "vitest";
import { encodeRouteUpdate } from "@pt/shared/proto";

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: { getState: () => ({ getApiUrl: () => "/api/vilnius" }) },
}));
import { api } from "../../src/services/api.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["route-7", "route-7"],
  ["agency:7", "agency:7"],
  ["a.b_c", "a.b_c"],
  ["a#b?c/d%20", "a%23b%3Fc%2Fd%2520"],
  ["雪|🚌", "%E9%9B%AA%7C%F0%9F%9A%8C"],
])("carries %s as one route ID while preserving legacy allowed URLs", async (routeId, encoded) => {
  const update = { routeId, trips: [], generatedAt: 1 };
  // This stub checks transport identity, not server acceptance of the ID.
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(encodeRouteUpdate(update), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  expect(await api.fetchRouteRt(routeId)).toEqual(update);
  const url = new URL(fetch.mock.calls[0][0] as string);
  expect(url.pathname).toBe(`/api/vilnius/rt/${encoded}`);
  expect(url.search).toBe("");
  expect(url.hash).toBe("");
});

it.each([".", ".."])("rejects dot-only ID %s without requesting a different path", async routeId => {
  const fetch = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(api.fetchRouteRt(routeId)).rejects.toThrow("route ID");
  expect(fetch).not.toHaveBeenCalled();
});
