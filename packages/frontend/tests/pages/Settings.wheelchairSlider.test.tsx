import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrowserRouter } from "react-router-dom";
import { SettingsPage } from "../../src/pages/Settings.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { VISION_IMPAIRED_WALK_SPEED_MPS, WHEELCHAIR_WALK_SPEED_MPS } from "@pt/shared";

function renderSettings() {
  return render(
    <BrowserRouter>
      <I18nProvider>
        <SettingsPage />
      </I18nProvider>
    </BrowserRouter>,
  );
}

describe("Settings — walking-speed slider under wheelchair profile", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      walkSpeedMps: 1.4,
    } as never);
  });

  it("does not mark the slider aria-disabled on the default profile", () => {
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    expect(slider.getAttribute("aria-disabled")).not.toBe("true");
    // Hint element should not be in the DOM on default profile.
    const hints = document.querySelectorAll(
      "[data-testid='walking-speed-wheelchair-hint']",
    );
    expect(hints).toHaveLength(0);
  });

  it("marks the slider aria-disabled and links the hint when mobility=wheelchair", () => {
    useSettingsStore.setState({
      mobilityProfile: "wheelchair",
      walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    } as never);
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    expect(slider.getAttribute("aria-describedby")).toBe(
      "walking-speed-wheelchair-hint",
    );
    const hint = getByTestId("walking-speed-wheelchair-hint");
    expect(hint.id).toBe("walking-speed-wheelchair-hint");
    expect(hint.textContent).toMatch(/wheelchair/i);
  });

  it("does not call setWalkSpeedMps when slider fires a change under wheelchair profile", () => {
    // Test via the public store contract: even if a stray event fires
    // (e.g. programmatic UI interaction), the wheelchair-locked store
    // value must not change.
    useSettingsStore.setState({
      mobilityProfile: "wheelchair",
      walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    } as never);
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "2.5" } });
    // Store value preserved; no-op handler.
    expect(useSettingsStore.getState().walkSpeedMps).toBe(
      WHEELCHAIR_WALK_SPEED_MPS,
    );
  });

  it("setWalkSpeedMps fires normally on default profile", () => {
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "7.2" } });
    expect(useSettingsStore.getState().walkSpeedMps).toBe(2.0);
  });

  it("bicycle profile: store updated, slider NOT aria-disabled, hint absent, change updates walkSpeedMps", () => {
    // Click the bicycle button to activate the profile.
    const { getByTestId } = renderSettings();
    fireEvent.click(getByTestId("mobility-bicycle"));
    expect(useSettingsStore.getState().mobilityProfile).toBe("bicycle");

    // Slider must NOT be aria-disabled (bicycle does not lock the slider).
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    expect(slider.getAttribute("aria-disabled")).not.toBe("true");

    // Wheelchair hint must not appear.
    const hints = document.querySelectorAll(
      "[data-testid='walking-speed-wheelchair-hint']",
    );
    expect(hints).toHaveLength(0);

    // fireEvent.change should update the store (slider is unlocked).
    fireEvent.change(slider, { target: { value: "6.3" } });
    expect(useSettingsStore.getState().walkSpeedMps).toBeCloseTo(1.75, 10);
  });
});

describe("Settings — walking-speed slider in km/h", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      walkSpeedMps: 1.4,
    } as never);
  });

  it("steps by 0.1 km/h over the store's 0.5-3.0 m/s range", () => {
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    expect(slider.min).toBe("1.8");
    expect(slider.max).toBe("10.8");
    expect(slider.step).toBe("0.1");
    // 1.4 m/s is 5.04 km/h: thumb, label and spoken value all read 5.0.
    expect(slider.value).toBe("5");
    expect(slider.getAttribute("aria-valuetext")).toBe("5.0 km/h");
    expect(document.body.textContent).toContain("5.0 km/h");
  });

  it("stores a km/h choice as m/s", () => {
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "3.6" } });
    expect(useSettingsStore.getState().walkSpeedMps).toBeCloseTo(1.0, 10);
    expect(slider.value).toBe("3.6");
    expect(slider.getAttribute("aria-valuetext")).toBe("3.6 km/h");
  });

  it("puts the vision-impaired start on a slider step", () => {
    const { getByTestId } = renderSettings();
    fireEvent.click(getByTestId("mobility-vision_impaired"));
    expect(useSettingsStore.getState().walkSpeedMps).toBe(VISION_IMPAIRED_WALK_SPEED_MPS);
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    expect(slider.value).toBe("3.5");
  });

  it("shows the wheelchair speed rounded to the step", () => {
    useSettingsStore.setState({
      mobilityProfile: "wheelchair",
      walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    } as never);
    const { getByTestId } = renderSettings();
    const slider = getByTestId("walking-speed-slider") as HTMLInputElement;
    expect(slider.value).toBe("2.9");
    expect(slider.getAttribute("aria-valuetext")).toBe("2.9 km/h");
  });
});
