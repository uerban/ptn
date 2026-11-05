/**
 * Isolated test for VITE_PT_DEPARTURES_HEDGE_MS=0 being a true off-switch.
 *
 * Uses a top-level vi.mock on scheduleTileConstants so HEDGE_MS=0 applies to
 * the whole file without disturbing the main useDepartures.test.ts suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../src/services/scheduleTileConstants.ts", () => ({
  HEDGE_MS: 0,
  DEFAULT_SCHEDULE_TILE_LIMIT: 20,
  DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD: 100,
  DEFAULT_SCHEDULE_TILE_LOOKAHEAD_HOURS: 1,
}));

vi.mock("../../src/services/api.ts", () => ({
  api: {
    getDepartures: vi.fn(),
  },
  fetchManifest: vi.fn(),
  fetchRtTile: vi.fn(),
  ManifestUnavailableError: class ManifestUnavailableError extends Error {},
}));

vi.mock("../../src/stores/stopStore.ts", () => ({
  useStopStore: { getState: () => ({}) },
}));

vi.mock("../../src/services/scheduleTileFlag.ts", () => ({
  isScheduleTileEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock("../../src/services/errorReporter.ts", () => ({
  reportTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("../../src/services/scheduleTileReadPath.ts", () => ({
  departuresForStop: vi.fn(),
}));

import { api } from "../../src/services/api.ts";
import { useDepartures } from "../../src/hooks/useDepartures.ts";
import { departuresForStop } from "../../src/services/scheduleTileReadPath.ts";

const TILE_DEP = {
  routeId: "tile", routeShortName: "T", routeColor: "ff0000",
  mode: "BUS" as const, headsign: "Terminus",
  scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  tripId: "t_tile",
};

describe("useDepartures — HEDGE_MS=0 is a true off-switch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (api.getDepartures as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("HEDGE_MS=0: cold tile + hedge:true does NOT call /departures (canHedge false)", async () => {
    // Cold tile: signals download start then eventually settles.
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async (_a, opts) => {
      opts?.onTileDownloadStart?.();
      // Hang for a while — the hedge timer (if armed) would fire near-immediately at =0.
      await new Promise((r) => setTimeout(r, 2000));
      return { state: "ok", departures: [TILE_DEP], serviceState: "active" };
    });

    renderHook(() => useDepartures("S1", false, 1.5, { hedge: true }));

    // Advance well past where a setTimeout(fn, 0) would fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    // /departures must NOT have been called — =0 is an off-switch, not a 0-delay fire.
    expect(api.getDepartures).not.toHaveBeenCalled();
  });
});
