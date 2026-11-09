import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Departure } from "@pt/shared";
import { I18nContext } from "../../i18n/index.ts";
import { LIVE_STALE_AFTER_MS, LiveTimesNotice, type LiveTimesNoticeProps } from "./LiveTimesNotice.tsx";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { canUse } from "../../privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../../privacy/contextualPrompts.ts";
import {
  recordRealtimeHeader,
  REALTIME_AVAILABILITY_STORAGE_KEY,
} from "../../services/realtimeAvailability.ts";

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

const SCHEDULED: Departure = {
  routeId: "r1",
  routeShortName: "1",
  mode: "BUS",
  headsign: "Centre",
  scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  tripId: "t1",
};
const LIVE: Departure = { ...SCHEDULED, predictedTime: SCHEDULED.scheduledTime };

function renderNotice(props: Partial<LiveTimesNoticeProps> = {}) {
  return render(
    <LiveTimesNotice
      cityId="vilnius"
      cityName="Vilnius"
      departures={[SCHEDULED]}
      loading={false}
      unavailable={false}
      updatedAt={Date.now()}
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

function notice() {
  return screen.getByTestId("live-times-notice");
}

beforeEach(() => {
  localStorage.removeItem(REALTIME_AVAILABILITY_STORAGE_KEY);
  useNetworkDecisionsStore.getState().reset();
  __resetContextualPromptsForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LiveTimesNotice", () => {
  it("labels scheduled times and offers live times while they are not allowed", () => {
    renderNotice();
    expect(notice().dataset.state).toBe("scheduled-ask");
    expect(screen.getByText("Scheduled times")).toBeDefined();
    expect(screen.getByRole("button", { name: "Show live times" })).toBeDefined();
  });

  it("asks before connecting, and Allow grants live departures only", () => {
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Show live times" }));

    const disclosure = screen.getByTestId("flow-disclosure");
    expect(disclosure.textContent).toContain("This app's server");
    expect(disclosure.textContent).toContain("The stop you are viewing");
    // Focus lands on the prompt, not on Allow: a stray Enter grants nothing.
    expect(document.activeElement).toBe(disclosure);

    fireEvent.click(screen.getByRole("button", { name: "Show live times" }));
    expect(canUse("operator.realtime")).toBe(true);
    expect(Object.keys(useNetworkDecisionsStore.getState().decisions)).toEqual([
      "operator.realtime",
    ]);
    expect(useNetworkDecisionsStore.getState().decisions["operator.realtime"]?.source).toBe(
      "contextual",
    );
  });

  it("Not now records nothing and keeps the button", () => {
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Show live times" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
    expect(screen.queryByTestId("flow-disclosure")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show live times" }));
  });

  it("Escape answers Not now", () => {
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Show live times" }));
    // The prompt takes focus in place of the button that opened it.
    expect(document.activeElement).toBe(screen.getByTestId("flow-disclosure"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("flow-disclosure")).toBeNull();
    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
  });

  it("after Don't ask again the button stays and still offers Allow", () => {
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Show live times" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't ask again" }));
    expect(useNetworkDecisionsStore.getState().decisions["operator.realtime"]?.value).toBe("denied");

    fireEvent.click(screen.getByRole("button", { name: "Show live times" }));
    expect(screen.queryByRole("button", { name: "Don't ask again" })).toBeNull();
    fireEvent.click(within("flow-disclosure", "Show live times"));
    expect(canUse("operator.realtime")).toBe(true);
  });

  it("says when the city does not publish live times, without offering them", () => {
    recordRealtimeHeader("vilnius", "alerts");
    renderNotice();
    expect(notice().dataset.state).toBe("not-offered");
    expect(notice().textContent).toContain("Live times aren't available in Vilnius.");
    expect(screen.queryByRole("button", { name: "Show live times" })).toBeNull();
  });

  it("shows nothing extra while live times are current", () => {
    useNetworkDecisionsStore.getState().setDecision("operator.realtime", "allowed", "settings");
    renderNotice({ departures: [LIVE] });
    expect(screen.queryByTestId("live-times-notice")).toBeNull();
  });

  it("marks live times that stopped updating as possibly out of date", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    useNetworkDecisionsStore.getState().setDecision("operator.realtime", "allowed", "settings");
    const updatedAt = Date.now();
    renderNotice({ departures: [LIVE], updatedAt });
    expect(screen.queryByTestId("live-times-notice")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LIVE_STALE_AFTER_MS + 15_000);
    });
    expect(notice().dataset.state).toBe("stale");
    expect(notice().textContent).toContain("Live times may be out of date");
  });

  it("separates no live updates from live ones when allowed", () => {
    useNetworkDecisionsStore.getState().setDecision("operator.realtime", "allowed", "settings");
    renderNotice({ departures: [SCHEDULED] });
    expect(notice().dataset.state).toBe("none-reported");
    expect(screen.queryByRole("button", { name: "Show live times" })).toBeNull();
  });

  it("reports unavailable times instead of an empty timetable, with the way to live times", () => {
    renderNotice({ departures: [], unavailable: true });
    expect(notice().dataset.state).toBe("unavailable");
    expect(notice().textContent).toContain("aren't on this device yet");
    expect(screen.getByRole("button", { name: "Show live times" })).toBeDefined();
  });

  it("follows a decision made elsewhere (another tab or Settings)", () => {
    renderNotice();
    expect(notice().dataset.state).toBe("scheduled-ask");
    act(() => {
      useNetworkDecisionsStore.getState().setDecision("operator.realtime", "allowed", "settings");
    });
    expect(notice().dataset.state).toBe("none-reported");
  });
});

function within(testId: string, name: string): HTMLElement {
  const root = screen.getByTestId(testId);
  const button = Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent === name,
  );
  if (!button) throw new Error(`no ${name} button in ${testId}`);
  return button;
}
