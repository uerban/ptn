import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("isScheduleTileEnabled", () => {
  beforeEach(() => {
    // Reset URL to a clean state before each test
    window.history.replaceState({}, "", "/");
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("returns true by default (no env, no query param)", async () => {
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(true);
  });

  it("returns true when ?ptn_schedule_tile=true is in the URL", async () => {
    window.history.replaceState({}, "", "/?ptn_schedule_tile=true");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(true);
  });

  it("returns false when ?ptn_schedule_tile=false is in the URL (per-user opt-out)", async () => {
    window.history.replaceState({}, "", "/?ptn_schedule_tile=false");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(false);
  });

  it("returns false when VITE_PT_SCHEDULE_TILE_ENABLED=false (global rollback)", async () => {
    // Stub BEFORE importing — ENV_DEFAULT is computed at module load.
    vi.stubEnv("VITE_PT_SCHEDULE_TILE_ENABLED", "false");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(false);
  });

  it("URL ?ptn_schedule_tile=true overrides env=false", async () => {
    vi.stubEnv("VITE_PT_SCHEDULE_TILE_ENABLED", "false");
    window.history.replaceState({}, "", "/?ptn_schedule_tile=true");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(true);
  });

  it("returns false when VITE_PT_SCHEDULE_TILE_ENABLED=0 (parity with other default-on flags)", async () => {
    vi.stubEnv("VITE_PT_SCHEDULE_TILE_ENABLED", "0");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(false);
  });

  it("returns true when VITE_PT_SCHEDULE_TILE_ENABLED=true (anything but false/0 is ON)", async () => {
    vi.stubEnv("VITE_PT_SCHEDULE_TILE_ENABLED", "true");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(true);
  });

  it("ignores a non-canonical query value and uses the default (only true/false are honored)", async () => {
    window.history.replaceState({}, "", "/?ptn_schedule_tile=1");
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    expect(isScheduleTileEnabled()).toBe(true); // readUrlOverride → null → ENV_DEFAULT (true)
  });

  it("does not throw when window is undefined (SSR guard); returns the default", async () => {
    const { isScheduleTileEnabled } = await import("./scheduleTileFlag");
    vi.stubGlobal("window", undefined);
    try {
      // readUrlOverride() returns null when window is undefined → ENV_DEFAULT (true).
      expect(isScheduleTileEnabled()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
