import { describe, it, expect, vi } from "vitest";
import { api, BackendStartingError, HttpError } from "../../src/services/api.ts";

// Mirror tests/services/api.test.ts: mock cityStore so getBaseUrl() doesn't
// depend on real-store / CITIES init order.
vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: { getState: () => ({ getApiUrl: () => "/api/vilnius" }) },
}));

function mockFetch(status: number, contentType: string, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })));
}

describe("fetchJson startup-class errors", () => {
  it("throws BackendStartingError on a 200 with non-JSON body", async () => {
    mockFetch(200, "text/html", "<html>starting</html>");
    await expect(api.getColorConfig()).rejects.toBeInstanceOf(BackendStartingError);
  });
  it("throws HttpError with status 503 on a 503", async () => {
    mockFetch(503, "application/json", JSON.stringify({ error: { message: "loading" } }));
    const err = await api.getColorConfig().catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
  });
});
