import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: {
    getState: () => ({ getApiUrl: () => "/api/vilnius" }),
  },
}));

import { api } from "../../src/services/api.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("api.sendClientReport — transport contract", () => {
  it("POSTs the report to <base>/client-report as keepalive JSON", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const report = { kind: "no-wasm", appVersion: "1.2.345" };
    await api.sendClientReport(report);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/vilnius/client-report");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.keepalive).toBe(true);
    expect(init.body).toBe(JSON.stringify(report));
  });

  it("resolves without throwing when fetch rejects (fire-and-forget)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(api.sendClientReport({ kind: "other" })).resolves.toBeUndefined();
  });
});
