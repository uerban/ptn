import { describe, expect, it, vi } from "vitest";
import { LEVEL_FLOORS, type PrivacyPolicy } from "@pt/shared/privacy";
import {
  fetchBasemapStyle,
  isExternalBasemapAllowed,
} from "./basemapPrivacy.ts";

const controller = new AbortController();
const style = { version: 8, sources: {}, layers: [] };

describe("basemap privacy gate", () => {
  it("allows registered CARTO only below the local-only floor", () => {
    expect(isExternalBasemapAllowed(LEVEL_FLOORS.standard, "carto")).toBe(true);
    expect(isExternalBasemapAllowed(LEVEL_FLOORS.hardened, "carto")).toBe(false);
    expect(isExternalBasemapAllowed(LEVEL_FLOORS.standard, "unknown")).toBe(false);
  });

  it("does not fetch when local-only or when the provider is unknown", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchBasemapStyle({
        providerId: "carto",
        dark: false,
        signal: controller.signal,
        getPolicy: () => LEVEL_FLOORS.hardened,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    await expect(
      fetchBasemapStyle({
        providerId: "unknown",
        dark: false,
        signal: controller.signal,
        getPolicy: () => LEVEL_FLOORS.standard,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops a fetched style when policy changes before the response applies", async () => {
    let policy: PrivacyPolicy = LEVEL_FLOORS.standard;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      policy = LEVEL_FLOORS.hardened;
      return new Response(JSON.stringify(style), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      fetchBasemapStyle({
        providerId: "carto",
        dark: false,
        signal: controller.signal,
        getPolicy: () => policy,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fetches the registered theme URL when external detail stays enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(style), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchBasemapStyle({
        providerId: "carto",
        dark: true,
        signal: controller.signal,
        getPolicy: () => LEVEL_FLOORS.standard,
        fetchImpl,
      }),
    ).resolves.toEqual(style);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/dark-matter/);
  });
});
