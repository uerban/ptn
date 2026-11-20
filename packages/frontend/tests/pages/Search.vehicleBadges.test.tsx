import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";
import { SearchPage } from "../../src/pages/Search.tsx";

describe("Search vehicle filters", () => {
  const before = useGtfsDataStore.getState().raptorIndex;
  beforeEach(() => {
    useSettingsStore.setState({ excludedModes: [] });
    useGtfsDataStore.setState({ raptorIndex: { routes: [{ mode: "BUS" }, { mode: "TROLLEYBUS" }] } as unknown as RaptorIndex });
  });
  afterEach(() => {
    useGtfsDataStore.setState({ raptorIndex: before });
    useSettingsStore.setState({ excludedModes: [] });
  });

  it("draws each mode as a named badge that toggles the mode", () => {
    render(<MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const bus = screen.getByRole("button", { name: "Bus" });
    expect(bus).toHaveAttribute("aria-pressed", "true");
    expect(bus).toHaveTextContent("Bus");
    fireEvent.click(bus);
    expect(bus).toHaveAttribute("aria-pressed", "false");
    expect(useSettingsStore.getState().excludedModes).toContain("BUS");
  });
});
