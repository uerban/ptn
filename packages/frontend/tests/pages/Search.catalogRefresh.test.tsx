import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "../../src/pages/Search.tsx";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { activateCityData, CityDataContext, invalidateCityData, updateCityShapes, useCityDataStore } from "../../src/services/cityData.ts";
import { searchSuggestionsStream } from "../../src/services/searchSuggestions.ts";

vi.mock("../../src/hooks/useGeolocation.ts", () => ({ useGeolocation: () => ({ location: null, loading: false }) }));
vi.mock("../../src/services/poiFetchMode.ts", () => ({ resolvePoiFetchMode: () => "eager-bundle" }));
vi.mock("../../src/services/searchSuggestions.ts", () => ({ SUGGESTION_PAGE_SIZE: 15, searchSuggestions: vi.fn(), searchSuggestionsStream: vi.fn() }));
const stream = vi.mocked(searchSuggestionsStream);
const initialCity = useCityStore.getState().activeCity;
function catalog(generationId: string, name: string) {
  return new CityDataContext({ meta: { cityId: "vilnius", generatedAt: "2026-11-13" },
    stops: [{ id: "library", name, lat: 54.69, lon: 25.28 }], routes: [], calendar: [] },
  { id: "current", cityId: "vilnius", generationId, etag: generationId, generatedAt: "2026-11-13", lastSynced: 1 });
}
function mount() {
  render(<MemoryRouter><SearchPage /></MemoryRouter>);
  fireEvent.change(screen.getByRole("searchbox", { name: "Where to?" }), { target: { value: "Library" } });
}
const typedCalls = () => stream.mock.calls.filter(call => call[0] === "Library");
beforeEach(() => {
  invalidateCityData();
  useCityStore.setState({ activeCity: { ...initialCity, id: "vilnius" } });
  useSettingsStore.setState({ searchActiveFieldOnly: true });
  stream.mockReset();
  stream.mockImplementation(async (query, _city, _hint, _signal, _provider, callbacks) => {
    const rows = query ? useCityDataStore.getState().active?.values("gtfsStops") ?? [] : [];
    callbacks.onResults(rows.map(stop => ({ kind: "stop", stopId: stop.id, name: stop.name,
      lat: stop.lat, lon: stop.lon, score: 1 })), { done: true, emitSeq: 0 });
  });
});
afterEach(() => { cleanup(); invalidateCityData(); useCityStore.setState({ activeCity: initialCity }); });

describe("picker follows the active catalog", () => {
  it("retries the unchanged query when the first catalog becomes available", async () => {
    mount();
    await screen.findByText("No matching place suggestions");
    act(() => activateCityData(catalog("first", "Library first")));
    expect(await screen.findByRole("option", { name: /Library first/ })).toBeInTheDocument();
    expect(typedCalls()).toHaveLength(2);
  });

  it("removes old rows and aborts their request on same-city replacement", async () => {
    activateCityData(catalog("old", "Library old"));
    mount();
    await screen.findByRole("option", { name: /Library old/ });
    const previous = typedCalls().at(-1)!;
    act(() => activateCityData(catalog("new", "Library new")));
    expect(screen.queryByRole("option", { name: /Library old/ })).not.toBeInTheDocument();
    expect(previous[3].aborted).toBe(true);
    act(() => previous[5].onResults([{ kind: "stop", stopId: "late", name: "Library late",
      lat: 54.69, lon: 25.28, score: 1 }], { done: true, emitSeq: 1 }));
    expect(screen.queryByRole("option", { name: /Library late/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Library new/ })).toBeInTheDocument();
    expect(typedCalls()).toHaveLength(2);
  });

  it("clears selectable rows when the active catalog is invalidated", async () => {
    activateCityData(catalog("old", "Library old"));
    mount();
    await screen.findByRole("option", { name: /Library old/ });
    act(() => invalidateCityData());
    expect(screen.queryByRole("option", { name: /Library old/ })).not.toBeInTheDocument();
    await screen.findByText("No matching place suggestions");
  });

  it("keeps the same query and rows for a shape-only update", async () => {
    const current = catalog("same", "Library same");
    activateCityData(current);
    mount();
    await screen.findByRole("option", { name: /Library same/ });
    const count = typedCalls().length;
    act(() => { expect(updateCityShapes(current, [])).toBe(true); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    expect(typedCalls()).toHaveLength(count);
    expect(screen.getByRole("option", { name: /Library same/ })).toBeInTheDocument();
  });
});
