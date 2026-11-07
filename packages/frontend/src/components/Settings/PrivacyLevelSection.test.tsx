import { LEVEL_FLOORS } from "@pt/shared/privacy";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PrivacyLevelSection } from "./PrivacyLevelSection.tsx";
import { getPolicy, usePrivacyStore } from "../../stores/privacyStore.ts";
import { getNetworkDecision } from "../../privacy/canUse.ts";
import { resetFlows } from "../../test-helpers/networkDecisions.ts";

afterEach(() => cleanup());

beforeEach(() => {
  usePrivacyStore.getState().reset();
  resetFlows();
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

  test("renders one decision control per optional network flow, not policy axes", () => {
    const { container } = render(<PrivacyLevelSection />);
    for (const group of [
      "operator.realtime",
      "external.detailed-basemap@carto",
      "operator.place-search",
      "external.stop-search",
      "operator.remote-routing",
      "external.remote-routing@transitous",
    ]) {
      expect(container.querySelector(`[data-flow-group="${group}"]`)).not.toBeNull();
    }
    for (const axis of ["nearbyStopLookup", "basemapMode", "realTimePolling", "m10ThirdPartyEnabled"]) {
      expect(container.querySelector(`[data-axis-group="${axis}"]`)).toBeNull();
      expect(container.querySelector(`input[name="policy-axis-${axis}"]`)).toBeNull();
    }
    // Nearby-stop lookup is local: never offered as a network service.
    expect(container.querySelector('[data-flow-group="operator.nearby-stop-centroid"]')).toBeNull();
  });

  test("a network row writes only its own decision", () => {
    const { container } = render(<PrivacyLevelSection />);
    const on = container.querySelector(
      '[data-flow-group="operator.realtime"] input[value="allowed"]',
    ) as HTMLInputElement;
    fireEvent.click(on);
    expect(getNetworkDecision("operator.realtime")).toEqual({ value: "allowed", source: "settings" });
    expect(getNetworkDecision("operator.remote-routing").value).toBe("unset");
    expect(getPolicy()).toEqual(LEVEL_FLOORS.standard);
    expect(usePrivacyStore.getState().overrides).toEqual({});
  });

  test("network rows stay editable at every level", () => {
    usePrivacyStore.getState().setLevel("paranoid");
    const { container } = render(<PrivacyLevelSection />);
    const on = container.querySelector(
      '[data-flow-group="external.detailed-basemap@carto"] input[value="allowed"]',
    ) as HTMLInputElement;
    expect(on.disabled).toBe(false);
    fireEvent.click(on);
    expect(getNetworkDecision("external.detailed-basemap", "carto").value).toBe("allowed");
    expect(getPolicy()).toEqual(LEVEL_FLOORS.paranoid);
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
      screen.getByText(/per-install key/i),
    ).toBeDefined();
    expect(
      screen.getByText(/area-of-interest tiles from the PTN backend/i),
    ).toBeDefined();
  });
});
