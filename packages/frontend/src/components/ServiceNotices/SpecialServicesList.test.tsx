import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RoutingBundleData, ServiceNotice } from "@pt/shared";
import { I18nContext } from "../../i18n/index.ts";
import { useServiceNoticesStore } from "../../services/serviceNoticesStore.ts";
import { useCityDataStore } from "../../services/cityData.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useNoticeReminders } from "../../services/noticeReminders.ts";
import { SpecialServicesList } from "./SpecialServicesList.tsx";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en-GB", t: (k, f) => f ?? k, privacyReady: true, ensurePrivacyNamespace: () => {} }}>
      {children}
    </I18nContext.Provider>
  );
}

const xmas: ServiceNotice = {
  id: "xmas", routeIds: ["201"], kind: "seasonal", free: true,
  windows: [{ start: "2026-11-27T22:00:00Z", end: "2026-12-31T22:00:00Z" }],
  displayUntil: "2026-12-31", icon: "🎄", source: "https://example.org/xmas",
};
const freeDay: ServiceNotice = {
  id: "free-day", city: true, kind: "free", free: true,
  windows: [{ start: "2026-12-05T22:00:00Z", end: "2026-12-06T22:00:00Z" }],
  displayUntil: "2026-12-06", source: "https://example.org/free", text: { en: "Free rides on the city's day" },
};
const choir: ServiceNotice = {
  id: "choir", routeIds: ["1G"], kind: "event", free: false,
  windows: [{ start: "2026-12-03T16:00:00Z", end: "2026-12-03T17:30:00Z" }],
  displayUntil: "2026-12-03", icon: "🔔", source: "https://example.org/choir",
  text: { en: "Choir on board" }, trips: ["2026-12-03T16:00:00Z", "2026-12-03T16:45:00Z"],
};

const wire = {
  stops: [{ id: "a", name: "Stotis", lat: 0, lon: 0 }, { id: "b", name: "Katedra", lat: 0, lon: 0 }],
  routes: [
    { id: "201", shortName: "201", mode: "BUS", stopIds: ["a"], trips: [] },
    { id: "1G", shortName: "1G", mode: "BUS", stopIds: ["a", "b"], trips: [
      { tripId: "c1", serviceId: "all", headsign: "Katedra", departureSecs: [64800, 65400] },
      { tripId: "c2", serviceId: "all", headsign: "Katedra", departureSecs: [67500, 68100] },
    ] },
  ],
  calendar: [{ serviceId: "all", days: Array(7).fill(true), startDate: "20261101", endDate: "20261231", exceptions: {} }],
} as unknown as RoutingBundleData;

const at = (iso: string) => Date.parse(iso);

describe("SpecialServicesList", () => {
  beforeEach(() => {
    const city = useCityStore.getState().activeCity;
    useCityStore.setState({ activeCity: { ...city, id: "vilnius", tz: "Europe/Vilnius" } });
    useServiceNoticesStore.setState({ byCity: { vilnius: [xmas, freeDay, choir] } });
    useCityDataStore.setState({ active: { wire } as never });
    useNoticeReminders.setState({ byId: {} });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is hidden when nothing is active", () => {
    useServiceNoticesStore.setState({ byCity: { vilnius: [] } });
    render(<SpecialServicesList nowMs={at("2026-12-10T10:00:00Z")} />, { wrapper: Wrapper });
    expect(screen.queryByTestId("special-services")).toBeNull();
  });

  it("shows the Christmas bus during its window, with the source", () => {
    render(<SpecialServicesList nowMs={at("2026-12-10T10:00:00Z")} />, { wrapper: Wrapper });
    const card = screen.getByTestId("special-service");
    expect(card.dataset.notice).toBe("xmas");
    expect(card.textContent).toContain("Line 201: Special line, runs until 31 December");
    expect(card.textContent).toContain("Free ride");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("https://example.org/xmas");
  });

  it("shows a free day from the day before", () => {
    render(<SpecialServicesList nowMs={at("2026-12-05T08:00:00Z")} />, { wrapper: Wrapper });
    expect(screen.getAllByTestId("special-service").map((c) => c.dataset.notice)).toEqual(["xmas", "free-day"]);
  });

  it("the catch-it card lists each trip with its stop times", () => {
    render(<SpecialServicesList nowMs={at("2026-12-03T08:00:00Z")} />, { wrapper: Wrapper });
    const trips = screen.getAllByTestId("notice-trip");
    expect(trips.map((t) => t.querySelector("summary")?.textContent)).toEqual(["Leaves Stotis at 18:00", "Leaves Stotis at 18:45"]);
    expect(trips[0]!.textContent).toContain("18:10 Katedra");
  });

  it("hides Remind me without notification support", () => {
    vi.stubGlobal("Notification", undefined);
    render(<SpecialServicesList nowMs={at("2026-12-03T08:00:00Z")} />, { wrapper: Wrapper });
    expect(screen.getByTestId("notice-catch-it")).toBeTruthy();
    expect(screen.queryByTestId("notice-remind")).toBeNull();
  });

  it("asks for permission only on tap and shows the reminder time", async () => {
    const requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");
    vi.stubGlobal("Notification", Object.assign(function () {}, { permission: "default", requestPermission }));
    render(<SpecialServicesList nowMs={at("2026-12-03T08:00:00Z")} />, { wrapper: Wrapper });
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("notice-remind"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Reminder set for 17:30"));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Cancel reminder"));
    expect(screen.getByTestId("notice-remind")).toBeTruthy();
  });
});
