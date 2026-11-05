import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldWriteShapes, resetQuotaGuardForSync } from "../../src/services/gtfsQuotaGuard.ts";

function mock(usage: number, quota: number) {
  (navigator as any).storage = { estimate: vi.fn(async () => ({ usage, quota })) };
}

describe("gtfsQuotaGuard", () => {
  beforeEach(() => resetQuotaGuardForSync());

  it("true under 70%", async () => {
    mock(6_000_000, 10_000_000);
    expect(await shouldWriteShapes()).toBe(true);
  });

  it("false above 70%", async () => {
    mock(8_000_000, 10_000_000);
    expect(await shouldWriteShapes()).toBe(false);
  });

  it("memoises within one sync run", async () => {
    const fn = vi.fn(async () => ({ usage: 1, quota: 10 }));
    (navigator as any).storage = { estimate: fn };
    await shouldWriteShapes();
    await shouldWriteShapes();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resetQuotaGuardForSync re-evaluates", async () => {
    const fn = vi.fn(async () => ({ usage: 1, quota: 10 }));
    (navigator as any).storage = { estimate: fn };
    await shouldWriteShapes();
    resetQuotaGuardForSync();
    await shouldWriteShapes();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("true when storage API unsupported", async () => {
    (navigator as any).storage = undefined;
    expect(await shouldWriteShapes()).toBe(true);
  });

  describe("silent-default warnings", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns once when storage API is unsupported", async () => {
      (navigator as any).storage = undefined;
      expect(await shouldWriteShapes()).toBe(true);
      const hits = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("navigator.storage.estimate unavailable"),
      );
      expect(hits).toHaveLength(1);
    });

    it("warns once when estimate returns no usage/quota", async () => {
      (navigator as any).storage = { estimate: vi.fn(async () => ({})) };
      expect(await shouldWriteShapes()).toBe(true);
      const hits = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("storage.estimate returned no usage/quota"),
      );
      expect(hits).toHaveLength(1);
    });

    it("warns once when estimate throws", async () => {
      (navigator as any).storage = {
        estimate: vi.fn(async () => {
          throw new Error("boom");
        }),
      };
      expect(await shouldWriteShapes()).toBe(true);
      const hits = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("storage.estimate failed"),
      );
      expect(hits).toHaveLength(1);
    });
  });
});
