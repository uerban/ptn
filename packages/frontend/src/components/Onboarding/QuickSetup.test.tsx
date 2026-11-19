import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSetupText } from "../../setup/setupStrings.ts";
import { QuickSetup, recommendedSummaryKey, type QuickSetupProps } from "./QuickSetup.tsx";

afterEach(cleanup);

function renderQuick(overrides: Partial<QuickSetupProps> = {}) {
  const props: QuickSetupProps = {
    cityName: "Vilnius",
    realtimeKinds: undefined,
    startMode: "map",
    onStartModeChange: vi.fn(),
    onChoose: vi.fn(),
    onChangeCity: vi.fn(),
    busy: false,
    error: null,
    text: (key, vars) => formatSetupText({}, key, vars),
    ...overrides,
  };
  render(<QuickSetup {...props} />);
  return props;
}

describe("QuickSetup", () => {
  it("describes recommended settings by what the city publishes", () => {
    expect(recommendedSummaryKey(undefined)).toBe("setup.recommended.generic");
    expect(recommendedSummaryKey(["departures", "alerts"])).toBe("setup.recommended.both");
    expect(recommendedSummaryKey(["departures"])).toBe("setup.recommended.departuresOnly");
    expect(recommendedSummaryKey(["alerts"])).toBe("setup.recommended.alertsOnly");
    expect(recommendedSummaryKey([])).toBe("setup.recommended.none");
    renderQuick({ realtimeKinds: [] });
    expect(screen.getByText(/Vilnius does not publish live departures or service alerts/)).toBeTruthy();
  });

  it("offers Text first; the start-mode description follows the choice", () => {
    const props = renderQuick({ startMode: "text" });
    const modes = screen.getAllByRole("radio").filter((r) => r.getAttribute("name") === "setup-start-mode");
    expect(modes.map((r) => r.getAttribute("value"))).toEqual(["text", "map"]);
    const description = document.getElementById(modes[0]!.getAttribute("aria-describedby")!);
    expect(description?.textContent).toMatch(/without a map/);
    fireEvent.click(screen.getByRole("radio", { name: "Map mode" }));
    expect(props.onStartModeChange).toHaveBeenCalledWith("map");
  });

  it("shows the privacy level as equal choices with Recommended preselected", () => {
    const props = renderQuick();
    const levels = screen.getAllByRole("radio").filter((r) => r.getAttribute("name") === "setup-level");
    expect(levels.map((r) => r.getAttribute("value"))).toEqual(["recommended", "strict", "customize"]);
    expect((levels[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("More options and details")).toBeNull();
    // Screen readers say the level once, then its line as the description.
    expect(screen.getByRole("radio", { name: "Strict" }).getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Recommended" }));
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "recommended", detailedMap: true });
  });

  it("Continue names and applies the chosen level, without moving focus", () => {
    const props = renderQuick();
    const strict = screen.getByRole("radio", { name: /^Strict/ });
    strict.focus();
    fireEvent.click(strict);
    expect(document.activeElement).toBe(strict);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Strict" }));
    expect(props.onChoose).toHaveBeenLastCalledWith({ presetId: "strict" });
  });

  it("Custom asks the guided question in place and says why Continue waits", () => {
    const props = renderQuick({ startMode: "text" });
    fireEvent.click(screen.getByRole("radio", { name: /^Custom/ }));
    const proceed = screen.getByRole("button", { name: "Continue with Custom" }) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);
    expect(screen.getByText("Choose an answer above to continue.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Use live departures and service alerts/ }));
    expect(proceed.disabled).toBe(false);
    fireEvent.click(proceed);
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "customize", guidedChoice: "live-information" });
  });

  it("keeps the details of each level behind one Why it matters", () => {
    renderQuick();
    const why = screen.getByText("Why the privacy level matters").closest("details")!;
    expect(why.open).toBe(false);
    expect(why.contains(screen.getByText("History is kept for 7 days."))).toBe(true);
    expect(why.contains(screen.getByText(/reveal the city and timetable area/))).toBe(true);
  });

  it("puts Detailed map first and names the recipient while allowing Minimal map", () => {
    const props = renderQuick();
    const detailed = screen.getByRole("radio", { name: /^Detailed map/ });
    const line = document.getElementById(detailed.getAttribute("aria-describedby")!);
    expect(line?.textContent).toMatch(/sends the areas you view to CARTO/);
    const maps = screen.getAllByRole("radio").filter((radio) => radio.getAttribute("name") === "setup-map");
    expect(maps[0]).toBe(detailed);
    expect((detailed as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /^Minimal map/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Recommended" }));
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "recommended", detailedMap: false });
  });

  it("under Strict the map choice is one line, and switching back restores the pick", () => {
    const props = renderQuick();
    fireEvent.click(screen.getByRole("radio", { name: /^Minimal map/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Strict/ }));
    expect(screen.queryByRole("radio", { name: /^Detailed map/ })).toBeNull();
    expect(screen.getByText(/Strict keeps the map on this device/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Strict" }));
    expect(props.onChoose).toHaveBeenLastCalledWith({ presetId: "strict" });
    fireEvent.click(screen.getByRole("radio", { name: /^Recommended/ }));
    expect((screen.getByRole("radio", { name: /^Minimal map/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("Custom defaults to Minimal map when there is no explicit map choice", () => {
    renderQuick();
    fireEvent.click(screen.getByRole("radio", { name: /^Custom/ }));
    expect((screen.getByRole("radio", { name: /^Minimal map/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("Text mode shows no map choice", () => {
    const props = renderQuick({ startMode: "text" });
    expect(screen.queryByRole("group", { name: "Map" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Recommended" }));
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "recommended" });
  });

  it("says what starting downloads and what that request reveals, when the data is not here yet", () => {
    renderQuick({ downloadsCity: true });
    expect(screen.getByText(/downloads the timetables, stops and lines of Vilnius/).textContent).toMatch(
      /reveals the city you chose/,
    );
    cleanup();
    renderQuick({ downloadsCity: false });
    expect(screen.queryByText(/downloads the timetables/)).toBeNull();
  });
});
