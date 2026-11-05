import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { NearbyStopsList } from "../../src/components/Schedule/NearbyStopsList.tsx";
import type { StopGroupRecord } from "../../src/db/index.ts";
import type { LatLon } from "@pt/shared";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

// Mock gtfsDataStore — no RAPTOR index needed for basic rendering
vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: (selector: (s: { raptorIndex: null; stopNames: null }) => unknown) =>
    selector({ raptorIndex: null, stopNames: null }),
}));

// Mock directionResolver
vi.mock("../../src/services/directionResolver.ts", () => ({
  resolveDirections: () => [],
}));

// ------ Fixtures -------------------------------------------------------

function makeGroup(
  id: string,
  name: string,
  lat: number,
  lon: number,
  type: StopGroupRecord["type"] = "name_cluster",
): StopGroupRecord {
  return {
    groupId: id,
    name,
    stopIds: [`${id}-stop1`],
    type,
    lat,
    lon,
  };
}

// Groups placed at known positions relative to Warsaw city centre (52.23, 21.01)
const USER_LOCATION: LatLon = { lat: 52.23, lon: 21.01 };

// ~100 m north
const NEAR_GROUP = makeGroup("g-near", "Near Stop", 52.231, 21.01);
// ~500 m north
const MID_GROUP = makeGroup("g-mid", "Mid Stop", 52.235, 21.01);
// ~2 km north
const FAR_GROUP = makeGroup("g-far", "Far Stop", 52.248, 21.01);

// 6 extra stops to test the "show more" limit
const EXTRA_GROUPS = Array.from({ length: 6 }, (_, i) =>
  makeGroup(`g-extra-${i}`, `Extra Stop ${i}`, 52.26 + i * 0.001, 21.01),
);

// -----------------------------------------------------------------------

describe("NearbyStopsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders stop group names", () => {
    render(
      <NearbyStopsList
        groups={[NEAR_GROUP, MID_GROUP]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText("Near Stop")).toBeDefined();
    expect(screen.getByText("Mid Stop")).toBeDefined();
  });

  it("shows loading state when locating", () => {
    render(
      <NearbyStopsList
        groups={[]}
        userLocation={null}
        onStopSelect={vi.fn()}
        loading={true}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId("nearby-loading")).toBeDefined();
    expect(screen.queryByTestId("nearby-stops-list")).toBeNull();
  });

  it("sorts stops by distance — nearest first", () => {
    // Provide in reverse order to verify sorting
    render(
      <NearbyStopsList
        groups={[FAR_GROUP, NEAR_GROUP, MID_GROUP]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const cards = screen.getAllByTestId("stop-card");
    // First card should be Near Stop, second Mid Stop, third Far Stop
    expect(cards[0].getAttribute("aria-label")).toContain("Near Stop");
    expect(cards[1].getAttribute("aria-label")).toContain("Mid Stop");
    expect(cards[2].getAttribute("aria-label")).toContain("Far Stop");
  });

  it("sorts stops with user at 0,0 when no location provided (stable sort by id)", () => {
    // Without user location, distance defaults to 0 for all (sorted by insertion)
    render(
      <NearbyStopsList
        groups={[NEAR_GROUP, MID_GROUP, FAR_GROUP]}
        userLocation={null}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    // All three stops should still be visible
    expect(screen.getAllByTestId("stop-card")).toHaveLength(3);
  });

  it("limits initial display to MAX_VISIBLE_STOPS (6)", () => {
    const allGroups = [NEAR_GROUP, MID_GROUP, FAR_GROUP, ...EXTRA_GROUPS];
    // allGroups has 9 entries

    render(
      <NearbyStopsList
        groups={allGroups}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getAllByTestId("stop-card")).toHaveLength(6);
    expect(screen.getByTestId("show-more-btn")).toBeDefined();
  });

  it("shows all stops after clicking 'Show more'", () => {
    const allGroups = [NEAR_GROUP, MID_GROUP, FAR_GROUP, ...EXTRA_GROUPS];

    render(
      <NearbyStopsList
        groups={allGroups}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId("show-more-btn"));

    expect(screen.getAllByTestId("stop-card")).toHaveLength(allGroups.length);
    expect(screen.queryByTestId("show-more-btn")).toBeNull();
  });

  it("shows distance from user location on stop cards", () => {
    render(
      <NearbyStopsList
        groups={[NEAR_GROUP]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    // Distance should be displayed in the stop card
    const distanceEl = screen.getByTestId("stop-distance");
    expect(distanceEl.textContent).toBeTruthy();
    // Near Stop is ~111 m away from USER_LOCATION (0.001 degree lat diff)
    expect(distanceEl.textContent).toMatch(/m$/);
  });

  it("calls onStopSelect when a stop card is clicked", () => {
    const onSelect = vi.fn();

    render(
      <NearbyStopsList
        groups={[NEAR_GROUP]}
        userLocation={USER_LOCATION}
        onStopSelect={onSelect}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId("stop-card"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(NEAR_GROUP);
  });

  it("renders ExpandableStopGroup for name_numbered type", () => {
    const numberedGroup = makeGroup("g-num", "Numbered Bus Stop", 52.231, 21.01, "name_numbered");
    // Add multiple stopIds so expand button is shown
    numberedGroup.stopIds = ["s1", "s2", "s3"];

    render(
      <NearbyStopsList
        groups={[numberedGroup]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    // ExpandableStopGroup renders internally (it uses StopCard for its header)
    expect(screen.getByTestId("expandable-stop-group")).toBeDefined();
    // The expand toggle button should be present (only present in ExpandableStopGroup)
    expect(screen.getByTestId("group-expand-toggle")).toBeDefined();
  });

  it("does not show 'Show more' button when groups <= 6", () => {
    render(
      <NearbyStopsList
        groups={[NEAR_GROUP, MID_GROUP, FAR_GROUP]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.queryByTestId("show-more-btn")).toBeNull();
  });

  it("renders empty state when no groups", () => {
    render(
      <NearbyStopsList
        groups={[]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId("nearby-empty")).toBeDefined();
  });

  it("has accessible role=list with aria-label", () => {
    render(
      <NearbyStopsList
        groups={[NEAR_GROUP]}
        userLocation={USER_LOCATION}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const list = screen.getByRole("list", { name: /nearby stops/i });
    expect(list).toBeDefined();
  });
});
