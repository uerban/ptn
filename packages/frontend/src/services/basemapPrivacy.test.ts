import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETAILED_BASEMAP_FLOW,
  fetchBasemapStyle,
  isExternalBasemapAllowed,
} from "./basemapPrivacy.ts";
import { allowFlow, denyFlow, resetFlows } from "../test-helpers/networkDecisions.ts";

const controller = new AbortController();
const style = { version: 8, sources: {}, layers: [] };

function styleResponse(): Response {
  return new Response(JSON.stringify(style), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("basemap network gate", () => {
  beforeEach(() => resetFlows());

  it("allows a registered provider only once its decision is allowed", () => {
    expect(isExternalBasemapAllowed("carto")).toBe(false);
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(isExternalBasemapAllowed("carto")).toBe(true);
    expect(isExternalBasemapAllowed()).toBe(true);
    denyFlow(DETAILED_BASEMAP_FLOW, "carto");
    expect(isExternalBasemapAllowed("carto")).toBe(false);
  });

  it("never allows an unknown provider", () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "unknown");
    expect(isExternalBasemapAllowed("unknown")).toBe(false);
  });

  it("does not fetch while unset or when the provider is unknown", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchBasemapStyle({ providerId: "carto", dark: false, signal: controller.signal, fetchImpl }),
    ).resolves.toBeNull();
    await expect(
      fetchBasemapStyle({
        providerId: "unknown",
        dark: false,
        signal: controller.signal,
        isAllowed: () => true,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops a fetched style when the decision is revoked before it applies", async () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    const fetchImpl = vi.fn().mockImplementation(async () => {
      denyFlow(DETAILED_BASEMAP_FLOW, "carto");
      return styleResponse();
    });

    await expect(
      fetchBasemapStyle({ providerId: "carto", dark: false, signal: controller.signal, fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fetches the registered theme URL once the provider is allowed", async () => {
    allowFlow(DETAILED_BASEMAP_FLOW, "carto");
    const fetchImpl = vi.fn().mockResolvedValue(styleResponse());

    await expect(
      fetchBasemapStyle({ providerId: "carto", dark: true, signal: controller.signal, fetchImpl }),
    ).resolves.toEqual(style);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/dark-matter/);
  });
});
