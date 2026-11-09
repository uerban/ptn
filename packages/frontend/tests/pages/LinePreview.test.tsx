import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { db } from "../../src/db/index.ts";

// Mock buildLinePatterns to avoid pulling the raptor index through Dexie.
// The real fn reads from useGtfsDataStore; mocking keeps this unit-scoped.
vi.mock("../../src/utils/buildLinePatterns.ts", () => ({
  buildLinePatterns: vi.fn(async () => [
    {
      directionId: 0,
      headsign: "Airport",
      stops: [
        { id: "s1", name: "Stop A", location: { lat: 54.68, lon: 25.28 } },
        { id: "s2", name: "Stop B", location: { lat: 54.69, lon: 25.29 } },
        { id: "s3", name: "Airport", location: { lat: 54.7, lon: 25.3 } },
      ],
    },
    {
      directionId: 1,
      headsign: "Home",
      stops: [
        { id: "s3", name: "Airport", location: { lat: 54.7, lon: 25.3 } },
        { id: "s2", name: "Stop B", location: { lat: 54.69, lon: 25.29 } },
        { id: "s1", name: "Stop A", location: { lat: 54.68, lon: 25.28 } },
      ],
    },
  ]),
}));

// Don't actually initialize the GTFS store (no fetch in tests).
vi.mock("../../src/stores/gtfsDataStore.ts", () => {
  const state = { init: vi.fn(), raptorIndex: null };
  const useGtfsDataStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useGtfsDataStore };
});

import { LinePreviewPage } from "../../src/pages/LinePreview.tsx";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { parkRtPolling } from "../helpers/parkRtPolling.ts";

function renderLinePreview(routeId = "route-42", dir?: string) {
  const path = dir ? `/line/${routeId}?dir=${dir}` : `/line/${routeId}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/line/:routeId" element={<LinePreviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LinePreviewPage", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.gtfsRoutes.clear();
    await seedLegacyCityProjection();
    await db.gtfsRoutes.add({
      id: "route-42",
      shortName: "42",
      mode: "BUS",
      color: "#1d4ed8",
      stopIds: ["s1", "s2", "s3"],
    });
    // Ensure the poller starts from a clean slate
    useRtStore.getState().unsubscribeAll();
    parkRtPolling();
  });

  afterEach(() => {
    useRtStore.getState().unsubscribeAll();
    vi.useRealTimers();
  });

  it("shows loading then renders the line header and stops", async () => {
    renderLinePreview();
    expect(screen.getByText(/loading line/i)).toBeInTheDocument();
    await waitFor(() => {
      // "Airport" appears as the current-direction headsign and also as a
      // stop name; either instance appearing means the page finished loading.
      expect(screen.getAllByText("Airport").length).toBeGreaterThan(0);
    });
    // Stop list entries — Stop A/B are unique
    expect(screen.getByText("Stop A")).toBeInTheDocument();
    expect(screen.getByText("Stop B")).toBeInTheDocument();
  });

  it("renders 'Line not found' when the route is absent in Dexie", async () => {
    await db.gtfsRoutes.clear();
    await seedLegacyCityProjection();
    renderLinePreview("missing-id");
    await waitFor(() => {
      expect(screen.getByText(/line not found/i)).toBeInTheDocument();
    });
  });

  it("subscribes to rtPoller on mount and unsubscribes on unmount without affecting other routes", async () => {
    const { poller } = useRtStore.getState();
    const otherCb = vi.fn();
    // Simulate a pre-existing subscription (e.g. guidance)
    poller.subscribe("other-route", otherCb);

    const { unmount } = renderLinePreview("route-42");
    await waitFor(() => {
      expect(screen.getAllByText("Airport").length).toBeGreaterThan(0);
    });

    // Our route is now subscribed
    expect(poller["subscriptions"].has("route-42")).toBe(true);
    // And the other-route subscription is still present
    expect(poller["subscriptions"].has("other-route")).toBe(true);

    unmount();

    // Route-42 is cleaned up; other-route is untouched.
    expect(poller["subscriptions"].has("route-42")).toBe(false);
    expect(poller["subscriptions"].has("other-route")).toBe(true);

    // Clean up the fake "other-route"
    poller.unsubscribe("other-route");
  });

  it("honors ?dir=1 to preselect the second direction", async () => {
    renderLinePreview("route-42", "1");
    // The direction-swap renders two `role="radio"`-ish buttons with
    // aria-pressed. dir=1 → the Home button should be pressed.
    await waitFor(() => {
      const homeBtn = screen.getByRole("button", { pressed: true });
      expect(homeBtn.textContent).toContain("Home");
    });
  });

  it("ignores NaN ?dir values and falls back to 0", async () => {
    renderLinePreview("route-42", "foo");
    // NaN → 0 → Airport button pressed
    await waitFor(() => {
      const airportBtn = screen.getByRole("button", { pressed: true });
      expect(airportBtn.textContent).toContain("Airport");
    });
  });
});
