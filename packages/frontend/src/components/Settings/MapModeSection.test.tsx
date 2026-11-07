import { LEVEL_FLOORS } from "@pt/shared/privacy";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { MapModeSection } from "./MapModeSection.tsx";
import { getPolicy, usePrivacyStore } from "../../stores/privacyStore.ts";
import { getNetworkDecision } from "../../privacy/canUse.ts";
import { allowFlow, denyFlow, resetFlows } from "../../test-helpers/networkDecisions.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";

afterEach(() => cleanup());

beforeEach(() => {
  usePrivacyStore.getState().reset();
  resetFlows();
  useSettingsStore.getState().setMapDetailMode("detailed");
});

function radio(container: HTMLElement, value: string): HTMLInputElement {
  return container.querySelector(
    `input[name="mapMode"][value="${value}"]`,
  ) as HTMLInputElement;
}

describe("MapModeSection", () => {
  test("renders one radio group with the three map modes", () => {
    const { container } = render(<MapModeSection />);
    for (const mode of ["detailed", "micromap", "gtfs-only"]) {
      expect(radio(container, mode)).not.toBeNull();
    }
    expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
  });

  test("choosing a local mode writes only the display setting", () => {
    allowFlow("external.detailed-basemap", "carto");
    const { container } = render(<MapModeSection />);
    fireEvent.click(radio(container, "micromap"));

    expect(useSettingsStore.getState().mapDetailMode).toBe("micromap");
    expect(getNetworkDecision("external.detailed-basemap", "carto").value).toBe("allowed");
    expect(usePrivacyStore.getState().overrides).toEqual({});
  });

  test("choosing the detailed map allows its provider", () => {
    useSettingsStore.getState().setMapDetailMode("gtfs-only");
    const { container } = render(<MapModeSection />);

    fireEvent.click(radio(container, "detailed"));
    expect(useSettingsStore.getState().mapDetailMode).toBe("detailed");
    expect(getNetworkDecision("external.detailed-basemap", "carto")).toEqual({
      value: "allowed",
      source: "settings",
    });
    expect(getPolicy()).toEqual(LEVEL_FLOORS.standard);
  });

  test("keeps the detailed option selectable at every level", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    const { container } = render(<MapModeSection />);
    expect(radio(container, "detailed").disabled).toBe(false);
    expect(radio(container, "micromap").disabled).toBe(false);
  });

  test("explains a demoted detailed preference and offers to allow it", () => {
    useSettingsStore.getState().setMapDetailMode("detailed");
    denyFlow("external.detailed-basemap", "carto");
    const { container, getByRole } = render(<MapModeSection />);

    expect(container.textContent ?? "").toMatch(/micromap is drawn instead/i);
    fireEvent.click(getByRole("button", { name: /use detailed maps/i }));
    expect(getNetworkDecision("external.detailed-basemap", "carto").value).toBe("allowed");
    expect(container.textContent ?? "").not.toMatch(/micromap is drawn instead/i);
  });
});
