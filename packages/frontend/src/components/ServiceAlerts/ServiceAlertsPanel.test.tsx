import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Alert, ServiceAlertsResponse } from "@pt/shared";
import { I18nContext } from "../../i18n/index.ts";
import { getNetworkDecision } from "../../privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../../privacy/contextualPrompts.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { useOnboardingStore } from "../../stores/onboardingStore.ts";
import { newInstallRecord, writeOnboardingRecord } from "../../services/onboardingRecord.ts";
import { recordRealtimeHeader } from "../../services/realtimeAvailability.ts";
import { __resetAlertsOfferSessionForTests } from "../../services/serviceAlertsOffer.ts";
import {
  __resetServiceAlertsForTests,
  SERVICE_ALERTS_FLOW_ID,
} from "../../services/serviceAlertsClient.ts";
import type { AlertTarget } from "../../services/serviceAlertSelection.ts";
import { LATEST_WHATS_NEW_ID } from "../../services/whatsNew.ts";
import { ServiceAlertsPanel } from "./ServiceAlertsPanel.tsx";
import { ALERT_COLLAPSE_CHARS, safeAlertUrl } from "./ServiceAlertItem.tsx";

const CITY = "vilnius";
const TARGETS: AlertTarget[] = [{ stopId: "S1" }, { stopId: "S1", routeId: "R1", tripId: "T1" }];

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider
      value={{
        locale: "en",
        formattingLocale: "en",
        t: (key, fallback) => fallback ?? key,
        privacyReady: true,
        ensurePrivacyNamespace: () => {},
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    cause: "CONSTRUCTION",
    effect: "DETOUR",
    severity: "WARNING",
    header: [{ text: "Detour on Main St" }],
    description: [],
    url: [],
    activePeriods: [],
    informedEntities: [{ routeId: "R1" }],
    ...overrides,
  };
}

function body(alerts: Alert[], overrides: Partial<ServiceAlertsResponse> = {}): ServiceAlertsResponse {
  return {
    schemaVersion: 1,
    city: CITY,
    fetchedAt: new Date().toISOString(),
    stale: false,
    alerts,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function respond(payload: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function allow(): void {
  useNetworkDecisionsStore.getState().setDecision(SERVICE_ALERTS_FLOW_ID, "allowed", "settings");
}

async function renderPanel(props: Partial<Parameters<typeof ServiceAlertsPanel>[0]> = {}) {
  const view = render(
    <ServiceAlertsPanel
      cityId={CITY}
      cityName="Vilnius"
      targets={TARGETS}
      surface="departure-sheet"
      {...props}
    />,
    { wrapper: Wrapper },
  );
  await act(async () => {});
  return view;
}

function panel() {
  return screen.getByTestId("service-alerts-panel");
}

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  __resetContextualPromptsForTests();
  __resetAlertsOfferSessionForTests();
  writeOnboardingRecord({
    ...newInstallRecord({ kind: "new" }),
    applied: true,
    seenWhatsNew: LATEST_WHATS_NEW_ID,
  });
  useOnboardingStore.getState().load();
  fetchMock = vi.fn();
  respond(body([alert()]));
  __resetServiceAlertsForTests({ fetch: fetchMock as unknown as typeof fetch });
  recordRealtimeHeader(CITY, "departures, alerts");
});

afterEach(() => {
  cleanup();
  __resetServiceAlertsForTests();
});

describe("ServiceAlertsPanel", () => {
  it("offers alerts while undecided, without requesting them", async () => {
    await renderPanel();
    expect(panel().dataset.state).toBe("offer");
    expect(screen.getByText("Service alerts are available for Vilnius.")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("[aria-live]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await act(async () => {});
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/vilnius/alerts");
    expect(screen.getByTestId("service-alert").dataset.alertId).toBe("a1");
  });

  it("keeps Don't show again behind the secondary menu", async () => {
    await renderPanel();
    const more = screen.getByRole("button", { name: "More options for service alerts" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "Don't show again" }));
    expect(getNetworkDecision(SERVICE_ALERTS_FLOW_ID).value).toBe("denied");
    expect(screen.queryByTestId("service-alerts-panel")).toBeNull();
  });

  it("hides the offer for the session after Not now", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("service-alerts-offer")).toBeNull();
    expect(useOnboardingStore.getState().record?.alertsNotNow).toBe(1);
  });

  it("shows no offer in a city without alerts", async () => {
    recordRealtimeHeader(CITY, "departures");
    await renderPanel();
    expect(screen.queryByTestId("service-alerts-panel")).toBeNull();
  });

  it("says when the city publishes no alerts", async () => {
    allow();
    recordRealtimeHeader(CITY, "departures");
    await renderPanel();
    expect(panel().dataset.state).toBe("unavailable");
    expect(panel().textContent).toContain("Vilnius does not publish service alerts");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists matching alerts with a worded severity", async () => {
    allow();
    await renderPanel();
    expect(panel().dataset.state).toBe("alerts");
    const item = screen.getByTestId("service-alert");
    expect(within(item).getByTestId("service-alert-severity").textContent).toBe("Warning");
    expect(item.textContent).toContain("Detour on Main St");
  });

  it("reports none without claiming normal service", async () => {
    allow();
    respond(body([alert({ informedEntities: [{ routeId: "OTHER" }] })]));
    await renderPanel();
    expect(panel().dataset.state).toBe("none-reported");
    const status = screen.getByTestId("service-alerts-status").textContent ?? "";
    expect(status).toMatch(/No alerts reported here\. Checked \d{1,2}:\d{2}/);
    expect(status.toLowerCase()).not.toContain("normal");
  });

  it("shows loading until the first answer", async () => {
    allow();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await renderPanel();
    expect(panel().dataset.state).toBe("loading");
  });

  it("marks a stale feed", async () => {
    allow();
    respond(body([alert()], { stale: true, fetchedAt: "2026-11-07T08:00:00Z" }));
    await renderPanel();
    expect(panel().dataset.state).toBe("stale");
    expect(screen.getByTestId("service-alert")).toBeDefined();
    expect(screen.getByTestId("service-alerts-status").textContent).toContain("may be out of date");
  });

  it("reports a failed first request", async () => {
    allow();
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    await renderPanel();
    expect(panel().dataset.state).toBe("failed");
  });

  it("drops alerts that are not active now", async () => {
    allow();
    respond(
      body([
        alert({
          activePeriods: [{ start: "2000-01-01T00:00:00Z", end: "2000-01-02T00:00:00Z" }],
        }),
      ]),
    );
    await renderPanel();
    expect(panel().dataset.state).toBe("none-reported");
  });

  it("includes partial matches only when asked (line view)", async () => {
    allow();
    respond(body([alert({ informedEntities: [{ routeId: "R1", stopId: "S9" }] })]));
    await renderPanel({ targets: [{ routeId: "R1" }], surface: "line-view" });
    expect(panel().dataset.state).toBe("none-reported");
    cleanup();
    await renderPanel({ targets: [{ routeId: "R1" }], surface: "line-view", includePartial: true });
    expect(panel().dataset.state).toBe("alerts");
  });
});

describe("ServiceAlertItem", () => {
  it("collapses long text, marks other-language text and external links", async () => {
    allow();
    const long = "Buses run on a diversion route. ".repeat(10);
    expect(long.length).toBeGreaterThan(ALERT_COLLAPSE_CHARS);
    respond(
      body([
        alert({
          severity: "SEVERE",
          header: [{ text: "Eismo pakeitimai", language: "lt" }],
          description: [{ text: long, language: "en" }],
          url: [{ text: "https://example.org/alert" }],
        }),
      ]),
    );
    await renderPanel();
    const item = screen.getByTestId("service-alert");
    expect(within(item).getByTestId("service-alert-severity").textContent).toBe("Severe");
    expect(within(item).getByText("Eismo pakeitimai").getAttribute("lang")).toBe("lt");
    expect(within(item).getByTestId("service-alert-description").hasAttribute("lang")).toBe(false);

    const more = within(item).getByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(within(item).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );

    const link = within(item).getByTestId("service-alert-link");
    expect(link.getAttribute("href")).toBe("https://example.org/alert");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toContain("opens a website outside this app");
  });

  it("links only to web addresses", () => {
    expect(safeAlertUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeAlertUrl("not a url")).toBeUndefined();
    expect(safeAlertUrl("http://example.org/a")).toBe("http://example.org/a");
  });

  it("never asks for notification permission", async () => {
    const request = vi.fn();
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { requestPermission: request, permission: "default" }));
    allow();
    await renderPanel();
    fireEvent.click(screen.getByTestId("service-alert"));
    expect(request).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
