import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CityConfig } from "../../config/cities.ts";
import { SetupShell, type SetupShellProps } from "./SetupShell.tsx";

const setup = vi.hoisted(() => ({
  activateSetupCity: vi.fn(async () => {}),
  chooseSetupCity: vi.fn(async () => {}),
  completeSetup: vi.fn(async () => ({ stored: true })),
}));
vi.mock("../../setup/completeSetup.ts", () => setup);
vi.mock("../Settings/LanguagePicker.tsx", () => ({ LanguagePicker: () => null }));

const city = (id: string, name: string): CityConfig =>
  ({
    id,
    name,
    tz: "Europe/Vilnius",
    available: true,
    center: { lat: 0, lon: 0 },
    bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
  }) as CityConfig;

const QUICK = "How would you like to plan and explore?";
const CITY = "Choose your city";

function renderShell(overrides: Partial<SetupShellProps> = {}) {
  const props: SetupShellProps = {
    mode: "full",
    initialStep: "city",
    preselectedCityId: null,
    cities: [city("vilnius", "Vilnius"), city("riga", "Riga")],
    downloadedSizes: new Map(),
    installedCityIds: new Set(),
    offline: false,
    catalogStatus: "fresh",
    storageAvailable: true,
    deepLink: null,
    onDone: vi.fn(),
    ...overrides,
  };
  render(<SetupShell {...props} />);
  return props;
}

beforeEach(() => {
  history.replaceState(null, "");
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("SetupShell", () => {
  it("opens the city step in place when the city was chosen for the user", async () => {
    const back = vi.spyOn(history, "back");
    renderShell({ cities: [city("vilnius", "Vilnius")], initialStep: "quick", preselectedCityId: "vilnius" });
    expect(screen.getByRole("heading", { name: QUICK })).toBeTruthy();
    expect(screen.getByText("City: Vilnius")).toBeTruthy();
    // Nothing is requested to show this step.
    expect(setup.chooseSetupCity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change city" }));
    expect(back).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: CITY })).toBeTruthy();
    back.mockRestore();
  });

  it("goes back to the city step it came from", async () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    renderShell();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Riga/ }));
    });
    expect(setup.chooseSetupCity).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: QUICK })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Change city" }));
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
  });

  it("selects a city it did not ask about only when setup completes", async () => {
    const props = renderShell({ cities: [city("vilnius", "Vilnius")], initialStep: "quick", preselectedCityId: "vilnius" });
    expect(screen.getByText(/downloads the timetables, stops and lines of Vilnius/)).toBeTruthy();
    expect(setup.activateSetupCity).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start with strict privacy" }));
    });
    expect(setup.activateSetupCity).toHaveBeenCalledWith(expect.objectContaining({ id: "vilnius" }));
    expect(setup.completeSetup).toHaveBeenCalledOnce();
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  it("marks a suggested city on the city step without leaving it", () => {
    renderShell({ suggestedCityId: "riga" });
    expect(screen.getByRole("heading", { name: CITY })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Riga/ }).getAttribute("aria-current")).toBe("true");
    expect(setup.chooseSetupCity).not.toHaveBeenCalled();
  });
});
