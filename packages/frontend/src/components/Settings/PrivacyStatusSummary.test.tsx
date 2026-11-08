import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { I18nProvider } from "../../i18n/I18nProvider.tsx";
import { PrivacyStatusSummary } from "./PrivacyStatusSummary.tsx";
import { NetworkDecisionsSection } from "./NetworkDecisionsSection.tsx";
import { getCurrentLevel, usePrivacyStore } from "../../stores/privacyStore.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { useOnboardingStore } from "../../stores/onboardingStore.ts";
import { classifyInstallation } from "../../services/installClassifier.ts";
import { allowFlow, denyFlow, resetFlows } from "../../test-helpers/networkDecisions.ts";

afterEach(() => cleanup());

/** Render inside the i18n provider and wait for the privacy namespace. */
async function render(ui: ReactElement) {
  const result = rtlRender(<I18nProvider>{ui}</I18nProvider>);
  await screen.findByTestId("privacy-status");
  return result;
}

beforeEach(() => {
  localStorage.clear();
  usePrivacyStore.getState().reset();
  resetFlows();
  useOnboardingStore.setState({ record: null });
});

function statusName(): string {
  return screen.getByTestId("privacy-status-name").textContent ?? "";
}

describe("PrivacyStatusSummary", () => {
  test("names Recommended and the services it turned on", async () => {
    allowFlow("operator.realtime");
    allowFlow("operator.service-alerts");
    await render(<PrivacyStatusSummary />);
    expect(statusName()).toBe("Recommended");
    const status = screen.getByTestId("privacy-status");
    expect(status.textContent).toMatch(/On: Real-time updates from the PTN operator and Service alerts from the PTN operator\./);
    expect(status.textContent).toContain("choose a lower level below");
  });

  test("a single changed service makes the setup Custom, without touching the level", async () => {
    allowFlow("operator.realtime");
    allowFlow("operator.service-alerts");
    await render(<PrivacyStatusSummary />);
    act(() => denyFlow("operator.service-alerts"));
    expect(statusName()).toBe("Custom");
    expect(getCurrentLevel()).toBe("standard");
  });

  test("Strict describes retention, cover requests and how to lower the level", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    await render(<PrivacyStatusSummary />);
    expect(statusName()).toBe("Strict privacy");
    const status = screen.getByTestId("privacy-status");
    expect(status.textContent).toContain("History is kept on this device for 7 days.");
    expect(status.textContent).toContain("Delete data");
    expect(screen.getByTestId("privacy-tile-defense").textContent).toMatch(/two cover requests\.$/);
    expect(screen.getByTestId("privacy-tile-defense").textContent).not.toMatch(/every 2–5 minutes/);
    expect(status.textContent).toMatch(/never turns online services on or off/);
    expect(within(status).getByRole("heading").textContent).toContain("Current setup");
  });

  test("only Paranoid makes timed cover requests", async () => {
    await usePrivacyStore.getState().setLevel("paranoid", { confirm: () => true });
    await render(<PrivacyStatusSummary />);
    expect(screen.getByTestId("privacy-tile-defense").textContent).toMatch(/every 2–5 minutes/);
  });

  test("a carried-over stricter setting is labelled as such", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    await usePrivacyStore.getState().setOverride("m11TileDefense", "prefetch-padding-decoy");
    await render(<PrivacyStatusSummary />);
    const text = screen.getByTestId("privacy-tile-defense").textContent ?? "";
    expect(text).toMatch(/every 2–5 minutes/);
    expect(text).toMatch(/carried-over setting/);
  });

  test("at the lowest level there is nothing to lower", async () => {
    await usePrivacyStore.getState().setLevel("baseline", { confirm: () => true });
    await render(<PrivacyStatusSummary />);
    expect(screen.getByTestId("privacy-status").textContent).not.toMatch(/choose a lower level/);
    expect(screen.getByText(/No optional online services are on/)).toBeTruthy();
  });
});

describe("NetworkDecisionsSection for an existing installation", () => {
  test("says what changed and labels decisions kept from before the update", () => {
    localStorage.setItem(
      "ptn-privacy",
      JSON.stringify({ state: { level: "standard", overrides: {} }, version: 0 }),
    );
    classifyInstallation(localStorage);
    useOnboardingStore.getState().load();
    useNetworkDecisionsStore
      .getState()
      .setDecision("operator.realtime", "allowed", "legacy");

    rtlRender(<NetworkDecisionsSection />);
    const changes = screen.getByTestId("privacy-update-changes");
    expect(changes.textContent).toContain("What changed in this update");
    expect(changes.textContent).toContain("Service alerts are new");
    const realtime = document.querySelector('[data-flow-group="operator.realtime"]') as HTMLElement;
    expect(realtime.textContent).toContain("Kept from before the update");
    const group = within(realtime).getByRole("radiogroup");
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
  });

  test("a new installation sees no update note and no kept labels", () => {
    allowFlow("operator.realtime");
    rtlRender(<NetworkDecisionsSection />);
    expect(screen.queryByTestId("privacy-update-changes")).toBeNull();
    expect(document.body.textContent).not.toContain("Kept from before the update");
  });
});

describe("NetworkDecisionsSection rows", () => {
  test("a provider row grants and revokes only that provider", () => {
    usePrivacyStore.getState().setLevel("strict");
    rtlRender(<NetworkDecisionsSection />);
    const row = document.querySelector(
      '[data-flow-group="external.detailed-basemap@carto"]',
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("radio", { name: "On" }));
    const decisions = () => useNetworkDecisionsStore.getState().decisions;
    expect(decisions()["external.detailed-basemap@carto"]).toMatchObject({
      value: "allowed",
      source: "settings",
    });
    expect(decisions()["external.detailed-basemap"]).toBeUndefined();
    expect(getCurrentLevel()).toBe("strict");

    fireEvent.click(within(row).getByRole("radio", { name: "Off" }));
    expect(decisions()["external.detailed-basemap@carto"]).toMatchObject({ value: "denied" });
  });

  test("changing one service leaves the others as they were", () => {
    allowFlow("operator.realtime");
    rtlRender(<NetworkDecisionsSection />);
    const alerts = document.querySelector(
      '[data-flow-group="operator.service-alerts"]',
    ) as HTMLElement;
    fireEvent.click(within(alerts).getByRole("radio", { name: "On" }));
    const decisions = useNetworkDecisionsStore.getState().decisions;
    expect(decisions["operator.realtime"]).toMatchObject({ value: "allowed" });
    expect(decisions["operator.service-alerts"]).toMatchObject({ value: "allowed" });
  });
});
