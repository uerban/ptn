import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAdapterRegistry } from "../../src/adapters/registry.js";
import { TRANSITOUS_API_URL } from "@pt/shared";

describe("AdapterRegistry", () => {
  const registry = createAdapterRegistry();

  it("lists available adapters", () => {
    const names = registry.list();
    expect(names).toContain("motis");
  });

  it("returns motis as default adapter", () => {
    const adapter = registry.getDefault();
    expect(adapter.name).toBe("motis");
  });

  it("gets adapter by name", () => {
    const adapter = registry.get("motis");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("motis");
  });

  it("returns undefined for unknown adapter", () => {
    const adapter = registry.get("nonexistent");
    expect(adapter).toBeUndefined();
  });

  it("all() returns all registered adapters", () => {
    const all = registry.all();
    expect(all.length).toBeGreaterThan(0);
    expect(all[0].name).toBe("motis");
  });
});

describe("AdapterRegistry MOTIS_URL env var", () => {
  const originalEnv = process.env.MOTIS_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MOTIS_URL;
    } else {
      process.env.MOTIS_URL = originalEnv;
    }
  });

  it("creates registry with custom MOTIS_URL", async () => {
    process.env.MOTIS_URL = "https://custom-motis.example.com/api";
    const registry = createAdapterRegistry();
    const adapter = registry.getDefault();
    expect(adapter.name).toBe("motis");

    // Verify the adapter uses the custom URL
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      await adapter.searchStops("test");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("https://custom-motis.example.com/api");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("creates registry without MOTIS_URL (uses default)", () => {
    delete process.env.MOTIS_URL;
    const registry = createAdapterRegistry();
    const adapter = registry.getDefault();
    expect(adapter.name).toBe("motis");
    expect(registry.list()).toContain("motis");
  });

  it("falls back to default when MOTIS_URL is empty string", async () => {
    process.env.MOTIS_URL = "";
    const registry = createAdapterRegistry();
    const adapter = registry.getDefault();
    expect(adapter.name).toBe("motis");

    // Verify the adapter actually uses the default Transitous URL, not empty string
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      await adapter.searchStops("test");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain(TRANSITOUS_API_URL);
      expect(calledUrl).not.toBe("/v1/geocode?text=test");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
