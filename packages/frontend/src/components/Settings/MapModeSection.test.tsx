import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { MapModeSection } from "./MapModeSection.tsx";
import { getPolicy, usePrivacyStore } from "../../stores/privacyStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";

afterEach(() => cleanup());

beforeEach(() => {
  usePrivacyStore.getState().reset();
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

  test("choosing a local mode writes both the setting and the privacy axis", () => {
    const { container } = render(<MapModeSection />);
    fireEvent.click(radio(container, "micromap"));

    expect(useSettingsStore.getState().mapDetailMode).toBe("micromap");
    expect(getPolicy().basemapMode).toBe("local-only");
  });

  test("choosing the detailed map releases the axis override", () => {
    const { container } = render(<MapModeSection />);
    fireEvent.click(radio(container, "gtfs-only"));
    expect(getPolicy().basemapMode).toBe("local-only");

    fireEvent.click(radio(container, "detailed"));
    expect(useSettingsStore.getState().mapDetailMode).toBe("detailed");
    expect(getPolicy().basemapMode).toBe("external-detailed");
    expect(usePrivacyStore.getState().overrides.basemapMode).toBeUndefined();
  });

  test("locks the detailed option at Hardened and explains why", () => {
    usePrivacyStore.getState().setLevel("hardened");
    const { container } = render(<MapModeSection />);
    const detailed = radio(container, "detailed");

    expect(detailed.disabled).toBe(true);
    expect(detailed.closest("label")?.textContent ?? "").toMatch(/Locked/i);
    expect(radio(container, "micromap").disabled).toBe(false);
  });

  test("tells the user when a detailed preference is demoted by policy", () => {
    useSettingsStore.getState().setMapDetailMode("detailed");
    usePrivacyStore.getState().setLevel("strict");
    const { container } = render(<MapModeSection />);

    expect(container.textContent ?? "").toMatch(/micromap is drawn instead/i);
  });
});
