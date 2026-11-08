import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Itinerary } from "@pt/shared";

const calls = vi.hoisted(() => ({
  request: vi.fn(() => true),
  notify: vi.fn(async () => true),
  position: null as { lat: number; lon: number } | null,
}));
vi.mock("../../services/liveLocation.ts", () => ({
  liveLocation: {
    request: calls.request,
    getSnapshot: () => ({ position: calls.position }),
  },
}));
vi.mock("../../services/tripNotifications.ts", () => ({
  requestNotificationPermission: calls.notify,
}));

import { useTripStart } from "./TripStartExplainer.tsx";
import { pendingTripStartPrompts, type TripStartEnvironment } from "../../services/tripStart.ts";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";

const ITINERARY = {
  legs: [],
  departureTime: "2026-11-08T10:00:00Z",
  arrivalTime: "2026-11-08T10:30:00Z",
  durationSeconds: 1800,
} as unknown as Itinerary;

function env(overrides: Partial<TripStartEnvironment> = {}): TripStartEnvironment {
  return {
    geolocationPermission: async () => "prompt",
    notificationPermission: () => "default",
    hasPosition: () => false,
    ...overrides,
  };
}

beforeEach(() => {
  calls.request.mockClear();
  calls.notify.mockClear();
  useSettingsStore.setState({ gpsMode: "enabled", tripNotificationsEnabled: true });
  useGuidanceStore.getState().stopNavigation();
});
afterEach(() => {
  useGuidanceStore.getState().stopNavigation();
});

describe("pendingTripStartPrompts", () => {
  it("reports both prompts when neither permission was decided", async () => {
    expect(await pendingTripStartPrompts(env())).toEqual({ location: true, notifications: true });
  });

  it("does not report location once granted, denied, or a fix is already known", async () => {
    expect((await pendingTripStartPrompts(env({ geolocationPermission: async () => "granted" }))).location).toBe(false);
    expect((await pendingTripStartPrompts(env({ geolocationPermission: async () => "denied" }))).location).toBe(false);
    expect((await pendingTripStartPrompts(env({ hasPosition: () => true }))).location).toBe(false);
  });

  it("does not report location while GPS is off or waiting for Locate me", async () => {
    useSettingsStore.setState({ gpsMode: "disabled" });
    expect((await pendingTripStartPrompts(env())).location).toBe(false);
    useSettingsStore.setState({ gpsMode: "until-locate" });
    expect((await pendingTripStartPrompts(env())).location).toBe(false);
  });

  it("reports notifications only when trip notifications are on and undecided", async () => {
    expect((await pendingTripStartPrompts(env({ notificationPermission: () => "granted" }))).notifications).toBe(false);
    expect((await pendingTripStartPrompts(env({ notificationPermission: () => null }))).notifications).toBe(false);
    useSettingsStore.setState({ tripNotificationsEnabled: false });
    expect((await pendingTripStartPrompts(env())).notifications).toBe(false);
  });
});

function Harness({
  onStarted,
  pending,
}: {
  onStarted: () => void;
  pending: () => Promise<{ location: boolean; notifications: boolean }>;
}) {
  const tripStart = useTripStart(onStarted, pending);
  return (
    <>
      <button type="button" onClick={() => tripStart.request(ITINERARY)}>
        choose
      </button>
      {tripStart.dialog}
    </>
  );
}

describe("useTripStart", () => {
  it("starts at once, without an explanation, when nothing would prompt", async () => {
    const onStarted = vi.fn();
    render(<Harness onStarted={onStarted} pending={async () => ({ location: false, notifications: false })} />);
    fireEvent.click(screen.getByText("choose"));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("trip-start-explainer")).toBeNull();
    expect(useGuidanceStore.getState().phase).toBe("navigating");
    expect(calls.request).toHaveBeenCalledWith("navigation");
  });

  it("explains location and notifications before asking, and asks on Start trip", async () => {
    const onStarted = vi.fn();
    render(<Harness onStarted={onStarted} pending={async () => ({ location: true, notifications: true })} />);
    fireEvent.click(screen.getByText("choose"));
    const dialog = await screen.findByRole("dialog", { name: "Start trip guidance" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("trip-start-location").textContent).toMatch(/follow your progress/);
    expect(screen.getByTestId("trip-start-notifications").textContent).toMatch(/get-off alerts/);
    // Nothing is requested before the user's choice.
    expect(calls.request).not.toHaveBeenCalled();
    expect(calls.notify).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId("trip-start-confirm"));

    fireEvent.click(screen.getByTestId("trip-start-confirm"));
    expect(calls.request).toHaveBeenCalledWith("navigation");
    expect(calls.notify).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(useGuidanceStore.getState().phase).toBe("navigating");
    expect(screen.queryByTestId("trip-start-explainer")).toBeNull();
  });

  it("lists only the prompt that would appear", async () => {
    render(<Harness onStarted={vi.fn()} pending={async () => ({ location: false, notifications: true })} />);
    fireEvent.click(screen.getByText("choose"));
    await screen.findByTestId("trip-start-explainer");
    expect(screen.queryByTestId("trip-start-location")).toBeNull();
    expect(screen.getByTestId("trip-start-notifications")).toBeTruthy();
  });

  it("Cancel and Escape start nothing and return focus to the choice", async () => {
    const onStarted = vi.fn();
    render(<Harness onStarted={onStarted} pending={async () => ({ location: true, notifications: false })} />);
    const opener = screen.getByText("choose");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("trip-start-explainer");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("trip-start-explainer")).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    await screen.findByTestId("trip-start-explainer");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("trip-start-explainer")).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    expect(calls.request).not.toHaveBeenCalled();
    expect(useGuidanceStore.getState().phase).toBe("idle");
  });
});
