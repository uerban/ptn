import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import type { BaseEndpoint } from "@pt/shared";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";

/**
 * The map long-press action sheet hands an endpoint over through
 * `routingStore.origin` / `.destination` and navigates to /search. Before this
 * was wired, both slots were write-only: the sheet's buttons set them and no
 * component ever read them, so a dropped pin did nothing at all.
 */
function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>,
  );
}

function fieldValues(): string[] {
  return (screen.getAllByRole("searchbox") as HTMLInputElement[]).map(
    (f) => f.value,
  );
}

const pin: BaseEndpoint = { kind: "mappoint", lat: 54.6873, lon: 25.2797 };

describe("Search hydration from a handed-off endpoint", () => {
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
  });

  it("fills the From field from a pending origin and clears the store slot", async () => {
    useRoutingStore.getState().setOrigin(pin);
    renderSearch();

    await waitFor(() => expect(fieldValues()).toContain("Dropped pin"));
    // Consume-once: a later visit to /search must not re-apply the pin.
    expect(useRoutingStore.getState().origin).toBeNull();
  });

  it("fills the To field from a pending destination and clears the store slot", async () => {
    useRoutingStore.getState().setDestination(pin);
    renderSearch();

    await waitFor(() => expect(fieldValues()).toContain("Dropped pin"));
    expect(useRoutingStore.getState().destination).toBeNull();

    // Destination-only handoff leaves From empty for the live-GPS default.
    const values = fieldValues();
    expect(values.filter((v) => v === "Dropped pin")).toHaveLength(1);
  });

  it("shows the stop name when the pin snapped to a nearby stop group", async () => {
    useRoutingStore.getState().setOrigin({
      kind: "stop",
      stopId: "stop-a",
      name: "Cathedral Sq",
      lat: 54.6873,
      lon: 25.2797,
    });
    renderSearch();

    await waitFor(() => expect(fieldValues()).toContain("Cathedral Sq"));
  });

  it("fills both fields when origin and destination are both pending", async () => {
    useRoutingStore.getState().setOrigin({
      kind: "stop",
      stopId: "stop-a",
      name: "Cathedral Sq",
      lat: 54.6873,
      lon: 25.2797,
    });
    useRoutingStore.getState().setDestination(pin);
    renderSearch();

    await waitFor(() => {
      const values = fieldValues();
      expect(values).toContain("Cathedral Sq");
      expect(values).toContain("Dropped pin");
    });
    expect(useRoutingStore.getState().origin).toBeNull();
    expect(useRoutingStore.getState().destination).toBeNull();
  });

  it("leaves the fields alone when nothing is pending", async () => {
    renderSearch();

    await waitFor(() => expect(fieldValues().length).toBeGreaterThan(0));
    expect(fieldValues().every((v) => v === "")).toBe(true);
  });
});
