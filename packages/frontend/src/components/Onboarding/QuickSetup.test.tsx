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

  it("offers Text first with descriptions attached to each control", () => {
    const props = renderQuick();
    const radios = screen.getAllByRole("radio");
    expect(radios[0].getAttribute("value")).toBe("text");
    const text = screen.getByRole("radio", { name: /Text mode/ });
    const description = document.getElementById(text.getAttribute("aria-describedby")!);
    expect(description?.textContent).toMatch(/without a map/);
    fireEvent.click(text);
    expect(props.onStartModeChange).toHaveBeenCalledWith("text");
  });

  it("leads with one big button to continue to the map; the rest is under More options", () => {
    const props = renderQuick();
    const more = screen.getByText("More options and details").closest("details")!;
    expect(more.open).toBe(false);
    expect(screen.getByRole("heading", { name: "Ready to start" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue to the map" }));
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "recommended" });
    // The mode choice, strict and customize live inside the expandable section.
    expect(more.contains(screen.getByRole("radio", { name: /Map mode/ }))).toBe(true);
    expect(more.contains(screen.getByRole("button", { name: "Start with strict privacy" }))).toBe(true);
    expect(more.contains(screen.getByRole("button", { name: "Customize" }))).toBe(true);
  });

  it("names the big button by the chosen start mode", () => {
    renderQuick({ startMode: "text" });
    expect(screen.queryByRole("button", { name: "Continue to the map" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start with recommended settings" })).toBeTruthy();
  });

  it("starts with strict from the details", () => {
    const props = renderQuick();
    fireEvent.click(screen.getByRole("button", { name: "Start with strict privacy" }));
    expect(props.onChoose).toHaveBeenLastCalledWith({ presetId: "strict" });
  });

  it("customize asks the guided question without repeating the presentation question", () => {
    const props = renderQuick({ startMode: "text" });
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByText("You will start in Text mode.")).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /mode/ })).toHaveLength(2);
    const proceed = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Use live departures and service alerts/ }));
    fireEvent.click(proceed);
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "customize", guidedChoice: "live-information" });
  });

  it("lists the strict level's effects one expansion away", () => {
    renderQuick();
    expect(screen.getByText("History is kept for 7 days.")).toBeTruthy();
    expect(screen.getByText(/reveal the city and timetable area/)).toBeTruthy();
    expect(screen.getByText("You can lower this later in Settings.")).toBeTruthy();
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
