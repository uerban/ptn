import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Tbilisi staging opt-in", () => {
  it.each([undefined, "0", "false", "true", "1"])(
    "enables city selection only for the explicit 1 flag (%s)",
    async (flag) => {
      vi.stubEnv("VITE_PT_TBILISI_ENABLED", flag);
      vi.resetModules();
      const { CITIES, getAvailableCities, findNearestCity } = await import("./cities.ts");
      const city = CITIES.find((c) => c.id === "tbilisi")!;
      expect(city.tz).toBe("Asia/Tbilisi");
      expect(city.transitSources?.map((s) => s.name)).toEqual([
        "Tbilisi Transport Company", "Tbilisi GTFS", "Transitous",
      ]);
      expect(city.available).toBe(flag === "1");
      expect(getAvailableCities().some((c) => c.id === city.id)).toBe(flag === "1");
      expect(findNearestCity(city.center.lat, city.center.lon).id === city.id).toBe(flag === "1");
    },
  );
});
