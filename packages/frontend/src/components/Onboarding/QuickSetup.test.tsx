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

  it("starts with one preset action", () => {
    const props = renderQuick();
    fireEvent.click(screen.getByRole("button", { name: "Start with recommended settings" }));
    expect(props.onChoose).toHaveBeenCalledWith({ presetId: "recommended" });
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
});
