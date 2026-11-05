import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseEndpoint, LatLon } from "@pt/shared";
import { SearchPage } from "../../src/pages/Search.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { recordRecent } from "../../src/services/recents.ts";

const requestLocation = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../src/services/liveLocation.ts", () => ({ liveLocation: { request: requestLocation } }));
const geo = vi.hoisted(() => ({ location: null as LatLon | null }));
vi.mock("../../src/hooks/useGeolocation.ts", () => ({ useGeolocation: () => ({ location: geo.location, loading: false }) }));
vi.mock("../../src/services/poiFetchMode.ts", () => ({ resolvePoiFetchMode: () => "server-side" }));
vi.mock("../../src/services/searchSuggestions.ts", () => ({
  SUGGESTION_PAGE_SIZE: 15,
  searchSuggestions: vi.fn(async () => [{ kind: "stop", stopId: "other", name: "Another stop", lat: 54.71, lon: 25.31, score: 1 }]),
  searchSuggestionsStream: vi.fn(async () => {}),
}));
vi.mock("../../src/services/recents.ts", () => ({ recordRecent: vi.fn(async () => {}) }));
vi.mock("../../src/components/Search/SearchMapPicker.tsx", () => ({
  SearchMapPicker: ({ field, onSelect, onCancel }: { field: string; onSelect: (endpoint: BaseEndpoint) => void; onCancel: () => void }) => <div role="dialog" aria-label={`${field} map`}>
    <button onClick={() => onSelect({ kind: "mappoint", lat: 54.72, lon: 25.32 })}>Confirm pin</button>
    <button onClick={onCancel}>Cancel map</button>
  </div>,
}));
const wrapper = (url: string) => <MemoryRouter initialEntries={[url]}><SearchPage /></MemoryRouter>;
const to = () => screen.getByRole("searchbox", { name: "Where to?" });
const from = () => screen.getByRole("searchbox", { name: "From" });
beforeEach(() => {
  geo.location = null;
  vi.clearAllMocks();
  useSettingsStore.setState({ searchActiveFieldOnly: true, gpsMode: "enabled" });
});

describe("search endpoint actions", () => {
  it("switches fields from the swap slot without swapping their values", () => {
    render(wrapper("/search"));
    fireEvent.change(to(), { target: { value: "Airport" } });
    const switchButton = screen.getByRole("button", { name: /Edit origin/ });
    expect(switchButton.parentElement).toBe(to().parentElement?.parentElement);
    fireEvent.click(switchButton);
    expect(from()).toHaveFocus();
    expect(to()).toHaveValue("Airport");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /Swap origin and destination/ }).parentElement).toBe(switchButton.parentElement);
  });

  it("keeps the journey form open when swapping GPS with an entered destination", async () => {
    geo.location = { lat: 54.69, lon: 25.29 };
    render(wrapper("/search?toName=Airport&toLat=54.6&toLon=25.3"));
    await screen.findByRole("button", { name: /My location.*Change/ });
    fireEvent.click(screen.getByRole("button", { name: "Swap origin and destination" }));
    expect(from()).toHaveValue("Airport");
    expect(to()).toHaveValue("My location");
    expect(to()).not.toHaveFocus();
    expect(screen.getByRole("tablist", { name: "Sort" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose on map" })).toBeNull();
    // Swapping back must also leave the form open with the same two places.
    fireEvent.click(screen.getByRole("button", { name: "Swap origin and destination" }));
    expect(from()).toHaveValue("My location");
    expect(to()).toHaveValue("Airport");
    expect(screen.getByRole("tablist", { name: "Sort" })).toBeInTheDocument();
  });

  it("does not open the destination picker when a swap moves an empty field there", () => {
    render(wrapper("/search?toName=Airport&toLat=54.6&toLon=25.3"));
    fireEvent.click(screen.getByRole("button", { name: "Swap origin and destination" }));
    expect(to()).toHaveValue("");
    expect(to()).not.toHaveFocus();
    expect(screen.getByRole("tablist", { name: "Sort" })).toBeInTheDocument();
  });

  it("makes GPS explicitly changeable and does not overwrite a chosen replacement", async () => {
    geo.location = { lat: 54.69, lon: 25.29 };
    const url = "/search?toName=Airport&toLat=54.6&toLon=25.3";
    const view = render(wrapper(url));
    const gps = await screen.findByRole("button", { name: /My location.*Change/ });
    fireEvent.click(gps);
    expect(from()).toHaveFocus();
    expect(from()).toHaveAttribute("placeholder", "Search another starting point");
    fireEvent.change(from(), { target: { value: "Another" } });
    fireEvent.click(await screen.findByRole("option", { name: /Another stop/ }));
    geo.location = { lat: 54.8, lon: 25.4 };
    view.rerender(wrapper(url));
    expect(from()).toHaveValue("Another stop");
    expect(to()).toHaveValue("Airport");
  });

  it("keeps both draft texts on map cancellation and replaces only the chosen endpoint on confirmation", async () => {
    render(wrapper("/search"));
    fireEvent.focus(from());
    fireEvent.change(from(), { target: { value: "Home draft" } });
    fireEvent.focus(to());
    fireEvent.change(to(), { target: { value: "Airport draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose on map" }));
    await screen.findByRole("dialog", { name: "to map" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel map" }));
    expect(from()).toHaveValue("Home draft");
    expect(to()).toHaveValue("Airport draft");
    fireEvent.click(screen.getByRole("button", { name: "Choose on map" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm pin" }));
    expect(from()).toHaveValue("Home draft");
    expect(to()).toHaveValue("Dropped pin");
    expect(recordRecent).not.toHaveBeenCalled();
  });

  it("replaces a GPS origin on the map while retaining the destination", async () => {
    geo.location = { lat: 54.69, lon: 25.29 };
    render(wrapper("/search?toName=Airport&toLat=54.6&toLon=25.3"));
    fireEvent.click(await screen.findByRole("button", { name: /My location.*Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose on map" }));
    await screen.findByRole("dialog", { name: "from map" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    expect(from()).toHaveValue("Dropped pin");
    expect(to()).toHaveValue("Airport");
    expect(recordRecent).not.toHaveBeenCalled();
  });

  it("can request GPS before the first fix and applies it to the chosen field", async () => {
    const view = render(wrapper("/search"));
    fireEvent.focus(to());
    fireEvent.click(screen.getByRole("button", { name: "Use my current location" }));
    expect(requestLocation).toHaveBeenCalledWith("locate");
    geo.location = { lat: 54.69, lon: 25.29 };
    view.rerender(wrapper("/search"));
    await waitFor(() => expect(to()).toHaveValue("My location"));
    expect(recordRecent).not.toHaveBeenCalled();
  });

  it("offers no GPS request when location is completely off", () => {
    useSettingsStore.setState({ gpsMode: "disabled" });
    render(wrapper("/search"));
    fireEvent.focus(to());
    expect(screen.queryByRole("button", { name: "Use my current location" })).toBeNull();
    expect(requestLocation).not.toHaveBeenCalled();
  });

  it("lets the user choose GPS again without recording a recent place", async () => {
    geo.location = { lat: 54.69, lon: 25.29 };
    render(wrapper("/search?toName=Airport&toLat=54.6&toLon=25.3"));
    fireEvent.click(await screen.findByRole("button", { name: /My location.*Change/ }));
    fireEvent.change(from(), { target: { value: "Other" } });
    fireEvent.change(from(), { target: { value: "" } });
    expect(screen.queryByRole("button", { name: /My location.*Change/ })).toBeNull();
    expect(from()).toHaveAttribute("placeholder", "From");
    fireEvent.click(screen.getByRole("button", { name: "Use my current location" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /My location.*Change/ })).toBeInTheDocument());
    expect(to()).toHaveValue("Airport");
    expect(recordRecent).not.toHaveBeenCalled();
  });
});
