import { afterEach, describe, expect, it, vi } from "vitest";
import { isDeviceOnline } from "../../src/hooks/useConnectivity.ts";

describe("isDeviceOnline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns navigator.onLine when present", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isDeviceOnline()).toBe(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(isDeviceOnline()).toBe(true);
  });
});
