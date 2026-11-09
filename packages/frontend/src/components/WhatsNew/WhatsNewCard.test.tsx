import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Itinerary } from "@pt/shared";
import { getNetworkDecision } from "../../privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../../privacy/contextualPrompts.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { useOnboardingStore } from "../../stores/onboardingStore.ts";
import {
  newInstallRecord,
  ONBOARDING_RECORD_KEY,
  readOnboardingRecord,
  writeOnboardingRecord,
  type OnboardingRecord,
} from "../../services/onboardingRecord.ts";
import { recordRealtimeHeader } from "../../services/realtimeAvailability.ts";
import {
  __resetAlertsOfferSessionForTests,
  alertsOfferOpen,
  inlineAlertsOfferVisible,
} from "../../services/serviceAlertsOffer.ts";
import { SERVICE_ALERTS_FLOW_ID } from "../../services/serviceAlertsClient.ts";
import { LATEST_WHATS_NEW_ID } from "../../services/whatsNew.ts";
import { WhatsNewCard } from "./WhatsNewCard.tsx";

const CITY = "vilnius";

function seed(overrides: Partial<OnboardingRecord> = {}): void {
  writeOnboardingRecord({
    ...newInstallRecord({ kind: "existing" }),
    applied: true,
    seenWhatsNew: 0,
    ...overrides,
  });
  useOnboardingStore.getState().load();
}

function stored(): OnboardingRecord {
  const read = readOnboardingRecord();
  if (read.status !== "ok") throw new Error("no record");
  return read.record;
}

function renderCard() {
  return render(<WhatsNewCard placement="overlay" />);
}

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  useGuidanceStore.getState().reset();
  __resetContextualPromptsForTests();
  __resetAlertsOfferSessionForTests();
  useOnboardingStore.setState({ record: null });
  useCityStore.setState((s) => ({ activeCity: { ...s.activeCity, id: CITY, name: "Vilnius" } }));
  recordRealtimeHeader(CITY, "departures, alerts");
});

afterEach(() => {
  cleanup();
});

describe("WhatsNewCard", () => {
  it("lists unseen entries with the alerts offer, without taking focus or announcing", () => {
    seed();
    const before = document.activeElement;
    renderCard();
    const card = screen.getByTestId("whats-new");
    expect(card.textContent).toContain("Service alerts");
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDefined();
    expect(document.activeElement).toBe(before);
    expect(card.closest("[aria-live],[role=status],[role=alert],[role=dialog]")).toBeNull();
  });

  it("is not shown once seen (first install marks every entry seen)", () => {
    seed({ seenWhatsNew: LATEST_WHATS_NEW_ID });
    renderCard();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("waits while a trip is guided", () => {
    seed();
    useGuidanceStore.setState({ phase: "navigating", itinerary: { legs: [] } as unknown as Itinerary });
    renderCard();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("Turn on allows alerts; closing then stores the highest id without a Not now", () => {
    seed();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("allowed");
    expect(screen.getByTestId("whats-new-alerts-on")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(screen.queryByTestId("whats-new")).toBeNull();
    expect(stored().seenWhatsNew).toBe(LATEST_WHATS_NEW_ID);
    expect(stored().alertsNotNow).toBe(0);
  });

  it("closing without answering counts as Not now", () => {
    seed();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(stored().alertsNotNow).toBe(1);
    expect(stored().seenWhatsNew).toBe(LATEST_WHATS_NEW_ID);
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("unset");
  });

  it("Not now counts once, and the inline row then waits for a later session", () => {
    seed();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(stored().alertsNotNow).toBe(1);
    expect(
      inlineAlertsOfferVisible({
        decision: "unset",
        available: true,
        record: stored(),
        notNowThisSession: false,
      }),
    ).toBe(true);
  });

  it("a second Not now, after one inline, ends the asking", () => {
    seed({ alertsNotNow: 1 });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(stored().alertsNotNow).toBe(2);
    expect(
      alertsOfferOpen({ decision: "unset", available: true, record: stored() }),
    ).toBe(false);
  });

  it("shows no actions once the asking has ended", () => {
    seed({ alertsNotNow: 2 });
    renderCard();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(stored().alertsNotNow).toBe(2);
  });

  it("shows the entry without actions in a city without alerts", () => {
    recordRealtimeHeader(CITY, "departures");
    seed();
    renderCard();
    expect(screen.getByTestId("whats-new-entry")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(stored().alertsNotNow).toBe(0);
  });

  it("closes with Escape when nothing else has focus", () => {
    seed();
    renderCard();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("leaves Escape to a focused sheet", () => {
    seed();
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    renderCard();
    fireEvent.keyDown(other, { key: "Escape" });
    expect(screen.getByTestId("whats-new")).toBeDefined();
    other.remove();
  });

  it("closes when another tab closes it", () => {
    seed();
    renderCard();
    const record = { ...stored(), seenWhatsNew: LATEST_WHATS_NEW_ID };
    localStorage.setItem(ONBOARDING_RECORD_KEY, JSON.stringify(record));
    act(() => {
      useOnboardingStore.getState().load();
    });
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("never asks for notification permission", () => {
    const request = vi.fn();
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { requestPermission: request }));
    seed();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(request).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
