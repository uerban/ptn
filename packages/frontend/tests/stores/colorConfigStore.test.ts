import { describe, it, expect, vi, beforeEach } from "vitest";
import { useColorConfigStore } from "../../src/stores/colorConfigStore.ts";

vi.mock("../../src/services/api.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/api.ts")>();
  return { ...actual, api: { getColorConfig: vi.fn() } };
});

import { api } from "../../src/services/api.ts";

const mockConfig = {
  modes: [
    { id: "BUS", label: "Bus (blue)", parentMode: "BUS", color: "#0073AC", routeCount: 35, sampleRoutes: ["1", "2", "3"] },
    { id: "BUS:night", label: "Bus (black)", parentMode: "BUS", color: "#111111", routeCount: 5, sampleRoutes: ["N1", "N2"] },
  ],
  palettes: {
    light: {
      universal: { BUS: "#2B7AB5", "BUS:night": "#3A3A5C" },
      deuteranopia: { BUS: "#3366CC", "BUS:night": "#444466" },
      protanopia: { BUS: "#2255BB", "BUS:night": "#3D3D5A" },
      tritanopia: { BUS: "#0073AC", "BUS:night": "#2A1A1A" },
      highContrast: { BUS: "#0055FF", "BUS:night": "#FF5500" },
    },
    dark: {
      universal: { BUS: "#5BA8D9", "BUS:night": "#7A7AAC" },
      deuteranopia: { BUS: "#66AAFF", "BUS:night": "#8888AA" },
      protanopia: { BUS: "#5599DD", "BUS:night": "#7D7DAA" },
      tritanopia: { BUS: "#33AADD", "BUS:night": "#6A3A3A" },
      highContrast: { BUS: "#55AAFF", "BUS:night": "#FF8844" },
    },
  },
  universalLimited: false,
};

describe("colorConfigStore", () => {
  beforeEach(() => {
    useColorConfigStore.getState().reset();
    vi.clearAllMocks();
  });

  it("starts with null config", () => {
    expect(useColorConfigStore.getState().config).toBeNull();
  });

  it("fetches and stores config for a city", async () => {
    (api.getColorConfig as any).mockResolvedValue(mockConfig);
    await useColorConfigStore.getState().fetchForCity("vilnius");
    expect(useColorConfigStore.getState().config).toEqual(mockConfig);
    expect(useColorConfigStore.getState().cityId).toBe("vilnius");
  });

  it("does not re-fetch for same city", async () => {
    (api.getColorConfig as any).mockResolvedValue(mockConfig);
    await useColorConfigStore.getState().fetchForCity("vilnius");
    await useColorConfigStore.getState().fetchForCity("vilnius");
    expect(api.getColorConfig).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when city changes", async () => {
    (api.getColorConfig as any).mockResolvedValue(mockConfig);
    await useColorConfigStore.getState().fetchForCity("vilnius");
    await useColorConfigStore.getState().fetchForCity("tricity");
    expect(api.getColorConfig).toHaveBeenCalledTimes(2);
  });

  it("clears config when switching cities", async () => {
    (api.getColorConfig as any).mockResolvedValue(mockConfig);
    await useColorConfigStore.getState().fetchForCity("vilnius");
    expect(useColorConfigStore.getState().config).toEqual(mockConfig);

    let resolveSecond!: (v: any) => void;
    (api.getColorConfig as any).mockImplementation(
      () => new Promise((r) => { resolveSecond = r; }),
    );
    const fetchPromise = useColorConfigStore.getState().fetchForCity("tricity");
    // Config should be cleared while fetching the new city
    expect(useColorConfigStore.getState().config).toBeNull();
    expect(useColorConfigStore.getState().cityId).toBe("tricity");
    resolveSecond(mockConfig);
    await fetchPromise;
    expect(useColorConfigStore.getState().config).toEqual(mockConfig);
  });

  it("falls back to null on fetch error after retries", async () => {
    vi.useFakeTimers();
    (api.getColorConfig as any).mockRejectedValue(new Error("fail"));
    const fetchPromise = useColorConfigStore.getState().fetchForCity("vilnius");
    // Advance through all retry delays (2s, 4s, 8s)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await fetchPromise;
    expect(useColorConfigStore.getState().config).toBeNull();
    expect(api.getColorConfig).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    vi.useRealTimers();
  });

  it("retries and succeeds on transient failure", async () => {
    vi.useFakeTimers();
    (api.getColorConfig as any)
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(mockConfig);
    const fetchPromise = useColorConfigStore.getState().fetchForCity("vilnius");
    await vi.advanceTimersByTimeAsync(2_000);
    await fetchPromise;
    expect(useColorConfigStore.getState().config).toEqual(mockConfig);
    expect(api.getColorConfig).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("a second same-city fetch while the first is in-flight is a single-flight no-op", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    (api.getColorConfig as any).mockImplementation(() => {
      callCount++;
      // First attempt fails (bounded), the retry succeeds.
      return callCount === 1 ? Promise.reject(new Error("fail")) : Promise.resolve(mockConfig);
    });

    const callA = useColorConfigStore.getState().fetchForCity("vilnius");
    // Call B (same city, while loading) must be a no-op — the re-entry guard
    // short-circuits it, so it does NOT spawn a second retry loop (React Strict
    // Mode double-mount / rapid remount).
    const callB = useColorConfigStore.getState().fetchForCity("vilnius");

    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([callA, callB]);

    expect(useColorConfigStore.getState().config).toEqual(mockConfig);
    // Exactly 2 calls (A: one fail + one retry-success). A second loop spawned by
    // B would push this higher — so this pins the single-flight guarantee.
    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("retries a startup-class HttpError(503) indefinitely and auto-recovers on a later 200", async () => {
    vi.useFakeTimers();
    const { HttpError } = await import("../../src/services/api.ts");
    (api.getColorConfig as any)
      .mockRejectedValueOnce(new HttpError(503, "loading"))
      .mockRejectedValueOnce(new HttpError(503, "loading"))
      .mockRejectedValueOnce(new HttpError(503, "loading"))
      .mockRejectedValueOnce(new HttpError(503, "loading"))
      .mockResolvedValueOnce(mockConfig); // 5th call (> MAX_RETRIES) still retried because startup-class
    const p = useColorConfigStore.getState().fetchForCity("vilnius");
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(35_000);
    await p;
    expect(useColorConfigStore.getState().config).toEqual(mockConfig);
    expect((api.getColorConfig as any).mock.calls.length).toBeGreaterThan(4);
    vi.useRealTimers();
  });

  it("treats a genuine HttpError(500) as bounded → gives up after MAX_RETRIES", async () => {
    vi.useFakeTimers();
    const { HttpError } = await import("../../src/services/api.ts");
    (api.getColorConfig as any).mockRejectedValue(new HttpError(500, "boom"));
    const p = useColorConfigStore.getState().fetchForCity("vilnius");
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(useColorConfigStore.getState().config).toBeNull();
    expect(useColorConfigStore.getState().status).toBe("error");
    expect(api.getColorConfig).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("city switch mid-startup-retry abandons the old loop without overwriting", async () => {
    vi.useFakeTimers();
    const { HttpError } = await import("../../src/services/api.ts");
    (api.getColorConfig as any).mockRejectedValue(new HttpError(503, "loading"));
    const pA = useColorConfigStore.getState().fetchForCity("vilnius");
    await vi.advanceTimersByTimeAsync(2_500);
    (api.getColorConfig as any).mockResolvedValue(mockConfig);
    const pB = useColorConfigStore.getState().fetchForCity("tricity");
    await vi.advanceTimersByTimeAsync(35_000);
    await Promise.all([pA, pB]);
    expect(useColorConfigStore.getState().cityId).toBe("tricity");
    expect(useColorConfigStore.getState().config).toEqual(mockConfig);
    vi.useRealTimers();
  });
});
