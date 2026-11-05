import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import type { BaseEndpoint } from "@pt/shared";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";

/**
 * A half-filled trip used to fall through to RouteResults, whose empty state
 * reads "No routes found. Try a different time or destination." — blaming the
 * search for a form the user hasn't finished. Reachable from the map long-press
 * handoff (destination set, no location fix) and from the favourites bar.
 */
function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>,
  );
}

const pin: BaseEndpoint = { kind: "mappoint", lat: 54.6873, lon: 25.2797 };

beforeEach(async () => {
  useRoutingStore.setState({
    ranking: "fastest",
    results: [],
    error: null,
    loading: false,
    origin: null,
    destination: null,
  });
  await db.gtfsStops.clear();
  // jsdom exposes no navigator.geolocation, so the hook settles immediately
  // with no fix — the same state as a denied permission on a real device.
});

describe("Search with a half-specified trip", () => {
  it("asks for a starting point instead of claiming no routes when only the destination is set", async () => {
    useRoutingStore.getState().setDestination(pin);
    renderSearch();

    await waitFor(() =>
      expect(screen.getByTestId("trip-incomplete")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Add a starting point/i)).toBeInTheDocument();
    expect(screen.queryByText(/No routes found/i)).toBeNull();
  });

  it("focuses the From field when the prompt is tapped", async () => {
    useRoutingStore.getState().setDestination(pin);
    renderSearch();

    await waitFor(() =>
      expect(screen.getByTestId("trip-incomplete")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Choose starting point/i }),
    );

    const fromField = screen.getAllByRole("searchbox")[0];
    expect(document.activeElement).toBe(fromField);
    // Focusing a field opens the suggestion panel, so the notice is gone.
    expect(screen.queryByTestId("trip-incomplete")).toBeNull();
  });

  it("asks for a destination once a swap empties the To field", async () => {
    useRoutingStore.getState().setDestination(pin);
    renderSearch();

    await waitFor(() =>
      expect(screen.getByTestId("trip-incomplete")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Swap origin and destination/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/Add a destination/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByRole("searchbox")[0]).toHaveValue("Dropped pin");
    expect(screen.queryByText(/No routes found/i)).toBeNull();
  });

});
