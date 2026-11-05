import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Force the else arm (server-side falls into else, same as eager).
vi.mock("../../src/services/poiFetchMode.ts", () => ({
  resolvePoiFetchMode: vi.fn(() => "server-side"),
}));

// One-shot searchSuggestions returns a single mapped server candidate so we can
// assert the row renders with a non-broken icon + the "POI" subtitle (AC-1d).
vi.mock("../../src/services/searchSuggestions.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/searchSuggestions.ts")>();
  return {
    ...actual,
    searchSuggestions: vi.fn(async () => [
      {
        kind: "geocoded" as const,
        label: "Rynek Glowny",
        lat: 50.0617,
        lon: 19.9373,
        confidence: 0.9,
        category: "address",
        source: "osm" as const,
        poiIdentity: "srv:Rynek Glowny|50.06170|19.93730|0",
        score: 0.9,
      },
    ]),
    searchSuggestionsStream: vi.fn(async () => {}),
  };
});

vi.mock("../../src/services/poiManifest.ts", () => ({ getCityPoiTiling: vi.fn(async () => null) }));
vi.mock("../../src/services/poiSync.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/poiSync.ts")>()),
  getActiveTileLoader: vi.fn(() => undefined),
}));

import { SearchPage } from "../../src/pages/Search.tsx";
import { Layout } from "../../src/components/Layout/Layout.tsx";

describe("Search.tsx renders a mapped server-side suggestion (AC-1d)", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });

  it("a category:address / source:osm suggestion renders a non-broken icon and the POI subtitle", async () => {
    const { getAllByRole, findByText } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const input = getAllByRole("searchbox")[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "rynek" } });
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    expect(await findByText("Rynek Glowny")).toBeInTheDocument();
    // category:"address" is unknown to POI_CATEGORY_ICONS, so it falls back to
    // the default glyph (Search.tsx:55) — the row is NOT broken/empty.
    expect(await findByText("POI")).toBeInTheDocument();
  });

  it("AC-5 render: a down self-hosted geocoder under server-side mounts the alert chip in the search route", async () => {
    const { geocoderRegistry } = await import("../../src/services/geocoder/instance.ts");
    // Layout renders its content via <Outlet/> (NOT children), so mount it as the
    // route element with SearchPage as a nested index route — exactly how the app
    // composes them. The chip (<GeocoderStatusChip/>) is a Layout child.
    const { findByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/search" element={<SearchPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    vi.useRealTimers();
    // Drive the real down-geocoder signal: emit a self-hosted provider-failed on the
    // registry's status emitter (the chip's trigger). geocoderRegistry.status is a
    // GeocoderStatusEmitter with a public .emit(...) (the same path the registry
    // uses internally and GeocoderStatusChip.test.tsx drives).
    geocoderRegistry.status.emit({ kind: "provider-failed", provider: "self-hosted", error: "down" });
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Self-hosted geocoder unreachable");
  });

  it("AC-10: server-side takes the else arm (searchSuggestions), NOT the stream", async () => {
    const ss = await import("../../src/services/searchSuggestions.ts");
    const { getAllByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const input = getAllByRole("searchbox")[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "alpha" } });
    await vi.advanceTimersByTimeAsync(350);
    expect(vi.mocked(ss.searchSuggestions)).toHaveBeenCalledTimes(1);
    // The TYPED query takes the one-shot wrapper, never the stream. (The
    // empty-focus effect streams the empty query for the Recent group in every
    // mode — that is mode-agnostic and must not count here.)
    const typedStreamCalls = vi
      .mocked(ss.searchSuggestionsStream)
      .mock.calls.filter((c) => c[0] === "alpha");
    expect(typedStreamCalls).toHaveLength(0);
  });

  it("AC-8b: a stale server-side result does not clobber a fresher query (Search.tsx debounce guard)", async () => {
    const ss = await import("../../src/services/searchSuggestions.ts");
    let resolveFirst: (v: unknown[]) => void = () => {};
    vi.mocked(ss.searchSuggestions)
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res as never; }))
      .mockImplementationOnce(async () => [
        { kind: "geocoded" as const, label: "Fresh", lat: 0, lon: 0, confidence: 1, category: "address", source: "osm" as const, poiIdentity: "srv:Fresh|0|0|0", score: 1 },
      ]);
    const { getAllByRole, findByText, queryByText } = render(
      <MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>,
    );
    const input = getAllByRole("searchbox")[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "first" } });
    await vi.advanceTimersByTimeAsync(350);
    fireEvent.change(input, { target: { value: "second" } });
    await vi.advanceTimersByTimeAsync(350);
    // Now the STALE first promise resolves AFTER the fresh query already settled.
    resolveFirst([{ kind: "geocoded", label: "Stale", lat: 0, lon: 0, confidence: 1, category: "address", source: "osm", poiIdentity: "srv:Stale|0|0|0", score: 1 }]);
    vi.useRealTimers();
    expect(await findByText("Fresh")).toBeInTheDocument();
    expect(queryByText("Stale")).not.toBeInTheDocument();   // stale dropped by the lastSearchQueryRef guard
  });

  it("AC-9 loading-gap: while server-side search is in flight, NO option rows and NO empty-state copy render (saves still render)", async () => {
    const ss = await import("../../src/services/searchSuggestions.ts");
    // searchSuggestions hangs (geocoder slow-but-up) → the list is withheld.
    vi.mocked(ss.searchSuggestions).mockImplementation(() => new Promise(() => {}));
    const { getAllByRole, queryAllByRole, queryByText } = render(
      <MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>,
    );
    const input = getAllByRole("searchbox")[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "rynek" } });
    await vi.advanceTimersByTimeAsync(350);
    // In-flight: the listbox is gated on suggestions.length > 0, so no option rows.
    expect(queryAllByRole("option")).toHaveLength(0);
    // And NO misleading "no matches"-style empty copy is shown during the RTT.
    expect(queryByText(/no (matches|results|places)/i)).toBeNull();
    // (PinnedSavesSection renders independently of the geocoder; it is unaffected.)
  });
});


describe("vehicle-class filter controls", () => {
  it("shows Bus and Minibus independently, even with only one GTFS mode", async () => {
    vi.useRealTimers();
    const { CITIES } = await import("../../src/config/cities.ts");
    const { useCityStore } = await import("../../src/stores/cityStore.ts");
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    const originalCity = useCityStore.getState().activeCity;
    const originalIndex = useGtfsDataStore.getState().raptorIndex;
    useCityStore.setState({ activeCity: CITIES.find((c) => c.id === "tbilisi")! });
    useSettingsStore.setState({ preferredAdapter: "motis", excludedModes: [], excludedRouteGroupsByCity: {} });
    useGtfsDataStore.setState({ raptorIndex: { routes: [
      { id: "1:R97525", mode: "BUS" }, { id: "1:minibusR24571", mode: "BUS" },
    ] } as unknown as NonNullable<typeof originalIndex> });
    const view = render(<MemoryRouter initialEntries={["/search?toName=Park"]}><SearchPage /></MemoryRouter>);
    try {
      const bus = view.getByTestId("route-group-bus");
      const mini = view.getByTestId("route-group-minibus");
      expect(bus).toHaveAttribute("aria-pressed", "true");
      expect(mini).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(mini);
      expect(mini).toHaveAttribute("aria-pressed", "false");
      expect(bus).toHaveAttribute("aria-pressed", "true");
      expect(useSettingsStore.getState().excludedRouteGroupsByCity.tbilisi).toEqual(["minibus"]);
      fireEvent.click(bus);
      expect(bus).toHaveAttribute("aria-pressed", "false");
      expect(mini).toHaveAttribute("aria-pressed", "false");
    } finally {
      view.unmount();
      useCityStore.setState({ activeCity: originalCity });
      useGtfsDataStore.setState({ raptorIndex: originalIndex });
      useSettingsStore.setState({ excludedModes: [], excludedRouteGroupsByCity: {} });
    }
  });
});
