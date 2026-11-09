import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CityConfig } from "../../config/cities.ts";
import { formatSetupText } from "../../setup/setupStrings.ts";
import { CitySelection, type CitySelectionProps } from "./CitySelection.tsx";

afterEach(cleanup);

const city = (id: string, name: string, available = true, countryCode?: string): CityConfig =>
  ({
    id,
    name,
    tz: "Europe/Vilnius",
    available,
    ...(countryCode ? { countryCode } : {}),
    center: { lat: 0, lon: 0 },
    bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
  }) as CityConfig;

const cities = [city("vilnius", "Vilnius"), city("riga", "Riga"), city("tallinn", "Tallinn", false)];

function renderList(overrides: Partial<CitySelectionProps> = {}) {
  const props: CitySelectionProps = {
    cities,
    downloadedSizes: new Map(),
    installedCityIds: new Set(),
    offline: false,
    catalogStatus: "fresh",
    preselectedCityId: null,
    busyCityId: null,
    text: (key, vars) => formatSetupText({}, key, vars),
    locale: "en",
    formatSize: (bytes) => `${bytes / 1_000_000} MB`,
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<CitySelection {...props} />);
  return props;
}

const cityButton = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("CitySelection", () => {
  it("lists a few cities as buttons without a filter", () => {
    const props = renderList();
    expect(screen.queryByLabelText("Find a city")).toBeNull();
    fireEvent.click(cityButton("Riga"));
    expect(props.onSelect).toHaveBeenCalledWith(cities[1]);
  });

  it("adds a filter once there are enough cities to search", () => {
    const many = [...cities, ...["a", "b", "c", "d", "e", "f"].map((id) => city(id, `City ${id}`))];
    const props = renderList({ cities: many });
    fireEvent.change(screen.getByLabelText("Find a city"), { target: { value: "rig" } });
    expect(screen.queryByRole("button", { name: /^Vilnius/ })).toBeNull();
    fireEvent.click(cityButton("Riga"));
    expect(props.onSelect).toHaveBeenCalledWith(many[1]);
    fireEvent.change(screen.getByLabelText("Find a city"), { target: { value: "zzz" } });
    expect(screen.getByText("No city matches “zzz”.")).toBeTruthy();
  });

  it("distinguishes downloaded, cached, unavailable and needs-a-connection cities", () => {
    renderList({
      offline: true,
      downloadedSizes: new Map([["vilnius", 12_000_000]]),
      installedCityIds: new Set(["vilnius", "riga"]),
    });
    expect(cityButton("Vilnius").textContent).toContain("Downloaded · 12 MB");
    expect(cityButton("Riga").textContent).toContain("Transit data saved on this device");
    expect((cityButton("Riga") as HTMLButtonElement).disabled).toBe(false);
    expect(cityButton("Tallinn").textContent).toContain("Transit data is not available yet");
    expect((cityButton("Tallinn") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/^No connection/).getAttribute("role")).toBe("status");
  });

  it("offers a retry when no catalog and no city data are available", () => {
    const props = renderList({ catalogStatus: "failed", cities: [] });
    expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it("explains a catalog limited to cities on this device", () => {
    renderList({ catalogStatus: "device-only" });
    expect(screen.getByText(/only cities whose transit data is on this device/).getAttribute("role")).toBe("status");
  });

  it("explains location use before asking, and asks only on the button", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
    renderList();
    expect(screen.getByText(/used on this device only/)).toBeTruthy();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("names each city's country, in the UI locale", () => {
    renderList({ cities: [city("vilnius", "Vilnius", true, "LT"), city("x", "Nowhere")] });
    expect(cityButton("Vilnius").textContent).toBe("Vilnius · Lithuania");
    expect(cityButton("Nowhere").textContent).toBe("Nowhere");
    cleanup();
    renderList({ cities: [city("vilnius", "Vilnius", true, "LT")], locale: "pl" });
    expect(cityButton("Vilnius").textContent).toBe("Vilnius · Litwa");
  });

  it("marks a time-zone suggestion without choosing it", () => {
    const props = renderList({ suggestedCityId: "riga" });
    expect(cityButton("Riga").getAttribute("aria-current")).toBe("true");
    expect(cityButton("Riga").textContent).toContain("Suggested from your device's time zone");
    expect(cityButton("Vilnius").getAttribute("aria-current")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("groups a long catalog by country in collapsed disclosures", () => {
    const grouped = [
      city("vilnius", "Vilnius", true, "LT"),
      city("kaunas", "Kaunas", true, "LT"),
      city("riga", "Riga", true, "LV"),
      ...["Gdańsk", "Kraków", "Warsaw", "Łódź", "Poznań", "Wrocław", "Lublin", "Szczecin"].map((name) =>
        city(name.toLowerCase(), name, true, "PL"),
      ),
    ];
    renderList({ cities: grouped, preselectedCityId: "kaunas" });
    const lithuania = screen.getByRole("button", { name: "Lithuania" });
    const poland = screen.getByRole("button", { name: "Poland" });
    // The group holding the preselected city starts open.
    expect(lithuania.getAttribute("aria-expanded")).toBe("true");
    expect(cityButton("Kaunas").getAttribute("aria-current")).toBe("true");
    expect(poland.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Warsaw/ })).toBeNull();
    // A one-city country is a city row at the same level.
    expect(cityButton("Riga").textContent).toBe("Riga · Latvia");

    poland.focus();
    fireEvent.click(poland);
    expect(poland.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(poland);
    const members = screen.getByRole("list", { name: "Poland" });
    expect(document.getElementById(poland.getAttribute("aria-controls")!)).toBe(members);
    // Inside its country group a city needs no country label.
    expect(cityButton("Warsaw").textContent).toBe("Warsaw");

    // Any query lists matches flat.
    fireEvent.change(screen.getByLabelText("Find a city"), { target: { value: "w" } });
    expect(screen.queryByRole("button", { name: "Poland" })).toBeNull();
    expect(cityButton("Wrocław").textContent).toBe("Wrocław · Poland");
  });
});
