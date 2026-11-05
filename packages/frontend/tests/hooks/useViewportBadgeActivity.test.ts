import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBadgeActivityStore } from "../../src/stores/badgeActivityStore.ts";
import { useMapViewportStore } from "../../src/stores/mapViewportStore.ts";
import { useStopStore } from "../../src/stores/stopStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

// Departure `mins` from now, in seconds since the FEED-TZ service-day midnight.
// The feed tz is mocked to UTC below, and the hook passes that tz to
// getDeparturesFromTile, which frames the look-ahead window on the feed wall
// clock. So this MUST be computed in UTC too — a device-local (getHours)
// encoding diverges from the feed-tz window on any non-UTC runner (this is the
// exact cross-tz bug the PR fixes; it flaked the test on the UTC CI runner
// while passing on a UTC+3 dev box).
function nowPlusMinsSecs(mins: number): number {
  const now = new Date();
  return now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds() + mins * 60;
}

// Pin the feed tz so the window framing is runner-independent.
vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: (selector: (s: { activeCity: { tz: string } }) => unknown) =>
    selector({ activeCity: { tz: "UTC" } }),
}));

const {
  resolveDecodedTileForStopMock,
  warmManifestMock,
  currentManifestMock,
  currentBundleHashMock,
} = vi.hoisted(() => ({
  resolveDecodedTileForStopMock:
    vi.fn<(stopId: string, onTileDownloadStart?: () => void, shared?: unknown) => Promise<unknown>>(),
  warmManifestMock: vi.fn<() => Promise<void>>(),
  currentManifestMock: vi.fn<() => unknown>(),
  currentBundleHashMock: vi.fn<() => string | null>(),
}));

vi.mock("../../src/services/scheduleTileReadPath.ts", () => ({
  resolveDecodedTileForStop: resolveDecodedTileForStopMock,
  warmManifest: warmManifestMock,
  currentManifest: currentManifestMock,
  currentBundleHash: currentBundleHashMock,
}));

const SHARED_MANIFEST = { schemaVersion: 1, bundleHash: "h", generatedAt: 0, tileSize: 6000 };

/** Mirrors the prior inline mock: an "ok" tile for stop "S", unavailable otherwise. */
function okResultForS(stopId: string): unknown {
  if (stopId === "S") {
    return {
      state: "ok",
      bundleHash: "h",
      tileCoords: "1_1",
      tile: {
        bundleHash: "h", cityId: "c", tileSize: 6000,
        stringTable: ["t", "head"],
        routes: [{ id: "R1", shortName: "1", longName: "", mode: "BUS" }],
        calendar: [{ serviceId: "svc", days: [true,true,true,true,true,true,true], startDate: "20260101", endDate: "20271231", added: [], removed: [] }],
        trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
        stops: { S: { tripIxs: Uint32Array.from([0]), departureSecs: Uint32Array.from([nowPlusMinsSecs(30)]) } },
      },
    };
  }
  return { state: "unavailable" };
}

beforeEach(() => {
  vi.clearAllMocks();
  warmManifestMock.mockResolvedValue(undefined);
  currentManifestMock.mockReturnValue(SHARED_MANIFEST);
  currentBundleHashMock.mockReturnValue("h");
  resolveDecodedTileForStopMock.mockImplementation(async (stopId: string) => okResultForS(stopId));
  useBadgeActivityStore.getState().clear();
  useSettingsStore.setState({ urbanMode: true, urbanLookaheadHours: 2 } as never);
  useStopStore.setState({
    stops: [
      { id: "S", name: "S", location: { lat: 1.0, lon: 1.0 }, lines: [{ routeId: "R1", shortName: "1", mode: "BUS" }] },
      { id: "FAR", name: "Far", location: { lat: 80, lon: 80 }, lines: [{ routeId: "R9", shortName: "9", mode: "BUS" }] },
    ],
    hydrated: true,
  } as never);
  useMapViewportStore.getState().setViewport({ north: 2, south: 0, east: 2, west: 0 }, 16);
});

describe("useViewportBadgeActivity", () => {
  it("computes ready activity for in-viewport stops only", async () => {
    const { useViewportBadgeActivity } = await import("../../src/hooks/useViewportBadgeActivity.ts");
    renderHook(() => useViewportBadgeActivity());
    await vi.waitFor(() => {
      const a = useBadgeActivityStore.getState().byStop.get("S");
      expect(a).toEqual({ state: "ready", routeIds: new Set(["R1"]) });
    });
    expect(useBadgeActivityStore.getState().byStop.has("FAR")).toBe(false);
  });

  it("computes activity for buffer-ring stops just outside the exact viewport", async () => {
    // TransitMap draws cards over a 1.5x buffered viewport, so a stop just
    // outside the exact bounds (north edge = 2) but within the buffer ring is
    // rendered as a card. Its badge activity MUST be computed too — otherwise
    // useVisibleStops fails open to the full (false) line set at the border.
    // The badge sweep must therefore cover the SAME buffered viewport as the
    // markers. EDGE at lat 2.5 is outside exact (2) but inside the 1.5x buffer
    // (expanded north = 3); the mock yields "unavailable" for non-S stops.
    useStopStore.setState({
      stops: [
        { id: "S",    name: "S",    location: { lat: 1.0, lon: 1.0 }, lines: [{ routeId: "R1", shortName: "1", mode: "BUS" }] },
        { id: "EDGE", name: "Edge", location: { lat: 2.5, lon: 1.0 }, lines: [{ routeId: "R2", shortName: "2", mode: "BUS" }] },
      ],
      hydrated: true,
    } as never);
    const { useViewportBadgeActivity } = await import("../../src/hooks/useViewportBadgeActivity.ts");
    renderHook(() => useViewportBadgeActivity());
    await vi.waitFor(() => {
      expect(useBadgeActivityStore.getState().byStop.get("EDGE")).toEqual({ state: "unavailable" });
    });
  });

  it("marks an out-of-tile / unresolvable in-viewport stop unavailable", async () => {
    useStopStore.setState({
      stops: [{ id: "X", name: "X", location: { lat: 1, lon: 1 }, lines: [{ routeId: "R", shortName: "r", mode: "BUS" }] }],
      hydrated: true,
    } as never);
    const { useViewportBadgeActivity } = await import("../../src/hooks/useViewportBadgeActivity.ts");
    renderHook(() => useViewportBadgeActivity());
    await vi.waitFor(() => {
      expect(useBadgeActivityStore.getState().byStop.get("X")).toEqual({ state: "unavailable" });
    });
  });

  it("resolves the manifest ONCE per round, not once per in-view stop (no manifest storm)", async () => {
    useStopStore.setState({
      stops: [
        { id: "S",  name: "S",  location: { lat: 1.0, lon: 1.0 }, lines: [{ routeId: "R1", shortName: "1", mode: "BUS" }] },
        { id: "S2", name: "S2", location: { lat: 1.1, lon: 1.1 }, lines: [{ routeId: "R1", shortName: "1", mode: "BUS" }] },
        { id: "S3", name: "S3", location: { lat: 1.2, lon: 1.2 }, lines: [{ routeId: "R1", shortName: "1", mode: "BUS" }] },
      ],
      hydrated: true,
    } as never);
    const { useViewportBadgeActivity } = await import("../../src/hooks/useViewportBadgeActivity.ts");
    renderHook(() => useViewportBadgeActivity());

    await vi.waitFor(() => expect(resolveDecodedTileForStopMock).toHaveBeenCalledTimes(3));
    // ONE manifest resolve for the whole round — NOT one per stop (the storm).
    expect(warmManifestMock).toHaveBeenCalledTimes(1);
    // Every per-stop resolve receives the shared manifest (3rd arg), so none re-fetches it.
    for (const call of resolveDecodedTileForStopMock.mock.calls) {
      expect(call[2]).toEqual({ manifest: SHARED_MANIFEST, bundleHash: "h" });
    }
  });
it("does not restart the sweep when stop identity churns without membership change", async () => {
    const { useViewportBadgeActivity } = await import("../../src/hooks/useViewportBadgeActivity.ts");
    renderHook(() => useViewportBadgeActivity());
    await vi.waitFor(() => {
      expect(useBadgeActivityStore.getState().byStop.get("S")?.state).toBe("ready");
    });
    const callsAfterFirstRound = resolveDecodedTileForStopMock.mock.calls.length;

    // Same in-view membership, fresh object + array identities — the exact
    // churn `upsertStops` produces on departure enrichment. The sweep loop
    // must NOT restart (no new tile resolves).
    const prev = useStopStore.getState().stops;
    useStopStore.setState({ stops: prev.map((s) => ({ ...s })) } as never);
    await new Promise((r) => setTimeout(r, 75));
    expect(resolveDecodedTileForStopMock.mock.calls.length).toBe(callsAfterFirstRound);

    // Actual membership change (new in-view stop) → sweep restarts.
    useStopStore.setState({
      stops: [
        ...prev,
        { id: "S2", name: "S2", location: { lat: 1.5, lon: 1.5 }, lines: [] },
      ],
    } as never);
    await vi.waitFor(() => {
      expect(resolveDecodedTileForStopMock.mock.calls.length).toBeGreaterThan(callsAfterFirstRound);
    });
  });
});
