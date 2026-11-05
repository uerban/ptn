import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PrivacyLevelSection } from "./PrivacyLevelSection.tsx";
import { getPolicy, usePrivacyStore } from "../../stores/privacyStore.ts";

afterEach(() => cleanup());

beforeEach(() => {
  usePrivacyStore.getState().reset();
});

describe("PrivacyLevelSection", () => {
  test("renders all 5 privacy levels as radios", () => {
    const { container } = render(<PrivacyLevelSection />);
    for (const lvl of [
      "baseline",
      "standard",
      "hardened",
      "strict",
      "paranoid",
    ]) {
      const r = container.querySelector(
        `input[name="privacy-level"][value="${lvl}"]`,
      );
      expect(r).not.toBeNull();
    }
  });

  test("selecting a level updates the store", () => {
    const { container } = render(<PrivacyLevelSection />);
    const paranoid = container.querySelector(
      `input[name="privacy-level"][value="paranoid"]`,
    ) as HTMLInputElement;
    fireEvent.click(paranoid);
    // Assert via the effective policy — paranoid's recentsEncryption floor
    // is "ram-only", which no other level has.
    expect(getPolicy().recentsEncryption).toBe("ram-only");
  });

  test("current level is reflected as checked", () => {
    usePrivacyStore.getState().setLevel("hardened");
    const { container } = render(<PrivacyLevelSection />);
    const hardened = container.querySelector(
      `input[name="privacy-level"][value="hardened"]`,
    ) as HTMLInputElement;
    expect(hardened.checked).toBe(true);
  });

  test("renders at least 3 PolicyAxisControl axes", () => {
    const { container } = render(<PrivacyLevelSection />);
    const axisNames = [
      "recentsEncryption",
      "savesEncryption",
      "mapTapPersistedPrecision",
    ];
    for (const axis of axisNames) {
      const any = container.querySelector(`input[name="policy-axis-${axis}"]`);
      expect(any).not.toBeNull();
    }
  });

  test("renders the nearby-stop control", () => {
    const { container } = render(<PrivacyLevelSection />);
    expect(
      container.querySelector('input[name="policy-axis-nearbyStopLookup"]'),
    ).not.toBeNull();
  });

  // basemapMode is driven by the single Map control (MapModeSection); the
  // privacy centre keeps the axis copy but must not render a second radio
  // group for the same decision.
  test("shows basemapMode read-only with a pointer to the Map control", () => {
    const { container } = render(<PrivacyLevelSection />);
    expect(
      container.querySelector('input[name="policy-axis-basemapMode"]'),
    ).toBeNull();
    const group = container.querySelector('[data-axis-group="basemapMode"]');
    expect(group).not.toBeNull();
    expect(group?.querySelector('a[href="#settings-map-mode"]')).not.toBeNull();
    expect(group?.textContent ?? "").toMatch(/external-detailed|Detailed/i);
  });

  test("locks centroid lookup at Hardened", () => {
    usePrivacyStore.getState().setLevel("hardened");
    const { container } = render(<PrivacyLevelSection />);
    const nearby = container.querySelector(
      'input[name="policy-axis-nearbyStopLookup"][value="centroid-server"]',
    ) as HTMLInputElement;
    expect(nearby.disabled).toBe(true);
  });

  test("axis below floor is disabled at hardened level with locked copy", () => {
    usePrivacyStore.getState().setLevel("hardened");
    const { container } = render(<PrivacyLevelSection />);
    const raw = container.querySelector(
      `input[name="policy-axis-mapTapPersistedPrecision"][value="raw"]`,
    ) as HTMLInputElement;
    expect(raw).not.toBeNull();
    expect(raw.disabled).toBe(true);
    expect(raw.closest("label")?.textContent ?? "").toMatch(/Locked/i);
  });

  test("renders threat-model disclosures", () => {
    render(<PrivacyLevelSection />);
    expect(screen.getByText(/stored in this browser/i)).toBeDefined();
    expect(
      screen.getByText(/Shareable URLs can carry coordinates/i),
    ).toBeDefined();
    expect(
      screen.getByText(/per-install encryption key/i),
    ).toBeDefined();
    expect(
      screen.getByText(/area-of-interest tiles from the PTN backend/i),
    ).toBeDefined();
  });
});
