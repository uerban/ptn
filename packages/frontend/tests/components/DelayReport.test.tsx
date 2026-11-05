import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DelayReport } from "../../src/components/Guidance/DelayReport.tsx";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useDelayReportStore } from "../../src/stores/delayReportStore.ts";
import { I18nContext } from "../../src/i18n/index.ts";
import type { Itinerary } from "@pt/shared";
import type { ReactNode } from "react";
import { parkRtPolling } from "../helpers/parkRtPolling.ts";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider
      value={{ locale: "en", formattingLocale: "en", t: mockT }}
    >
      {children}
    </I18nContext.Provider>
  );
}

const mockItinerary: Itinerary = {
  legs: [
    {
      mode: "WALK",
      from: { name: "Origin", location: { lat: 0, lon: 0 } },
      to: { name: "Stop A", location: { lat: 0, lon: 0 } },
      departureTime: "2026-04-10T10:00:00Z",
      arrivalTime: "2026-04-10T10:05:00Z",
      durationSeconds: 300,
      distanceMeters: 400,
    },
    {
      mode: "BUS",
      from: { name: "Stop A", location: { lat: 0, lon: 0 } },
      to: { name: "Stop B", location: { lat: 0, lon: 0 } },
      departureTime: "2026-04-10T10:08:00Z",
      arrivalTime: "2026-04-10T10:20:00Z",
      durationSeconds: 720,
      routeShortName: "42",
      headsign: "Central Station",
      tripId: "route-1:trip-1",
      intermediateStops: 4,
    },
  ],
  departureTime: "2026-04-10T10:00:00Z",
  arrivalTime: "2026-04-10T10:20:00Z",
  durationSeconds: 1200,
  transfers: 0,
  walkingDistanceMeters: 400,
};

describe("DelayReport", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
    useDelayReportStore.setState({ reports: [] });
    parkRtPolling();
  });

  it("renders nothing when not navigating", () => {
    const { container } = render(<DelayReport />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when navigating on a walk leg", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    // currentLegIndex is 0 (WALK leg, no tripId)
    const { container } = render(<DelayReport />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders report button when navigating on a transit leg", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg(); // advance to leg 1 (BUS)
    render(<DelayReport />, { wrapper: Wrapper });
    expect(screen.getByTestId("delay-report-btn")).toBeInTheDocument();
    expect(screen.getByText("Report delay")).toBeInTheDocument();
  });

  it("shows options when report button is clicked", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    render(<DelayReport />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId("delay-report-btn"));

    expect(screen.getByTestId("delay-report-options")).toBeInTheDocument();
    expect(screen.getByTestId("delay-option-on_time")).toBeInTheDocument();
    expect(screen.getByTestId("delay-option-slight")).toBeInTheDocument();
    expect(screen.getByTestId("delay-option-significant")).toBeInTheDocument();
    expect(screen.getByTestId("delay-option-major")).toBeInTheDocument();
    expect(screen.getByTestId("delay-option-cancelled")).toBeInTheDocument();
  });

  it("submitting a report saves to store and shows thanks", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    render(<DelayReport />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId("delay-report-btn"));
    fireEvent.click(screen.getByTestId("delay-option-slight"));

    // Should show thanks message
    expect(screen.getByTestId("delay-report-thanks")).toBeInTheDocument();
    expect(screen.getByText("Thanks for reporting!")).toBeInTheDocument();

    // Should have saved to store
    const reports = useDelayReportStore.getState().reports;
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe("slight");
    expect(reports[0].routeShortName).toBe("42");
  });

  it("passes location to the report when provided", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    render(
      <DelayReport position={{ lat: 54.35, lon: 18.65 }} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId("delay-report-btn"));
    fireEvent.click(screen.getByTestId("delay-option-on_time"));

    const reports = useDelayReportStore.getState().reports;
    expect(reports[0].location).toEqual({ lat: 54.35, lon: 18.65 });
  });

  it("closes options panel when close button is clicked", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    render(<DelayReport />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId("delay-report-btn"));
    expect(screen.getByTestId("delay-report-options")).toBeInTheDocument();

    const closeBtn = screen.getByLabelText("Close");
    fireEvent.click(closeBtn);

    expect(screen.queryByTestId("delay-report-options")).not.toBeInTheDocument();
    // Report button should be back
    expect(screen.getByTestId("delay-report-btn")).toBeInTheDocument();
  });
});
