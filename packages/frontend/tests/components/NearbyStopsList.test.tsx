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

const geo = vi.hoisted(() => ({ error: null as string | null, requestLocation: vi.fn() }));
vi.mock("../../src/hooks/useGeolocation.ts", () => ({
  useGeolocation: () => ({ location: null, loading: false, error: geo.error, requestLocation: geo.requestLocation }),
}));

import { useNearbyAnchorStore } from "../../src/stores/nearbyAnchorStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

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
    geo.error = null;
    useNearbyAnchorStore.getState().clear();
    useSettingsStore.setState({ gpsMode: "enabled" });
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

  it("lists stops by name without claiming distances when no location is known", () => {
    render(
      <NearbyStopsList
        groups={[NEAR_GROUP, MID_GROUP, FAR_GROUP]}
        userLocation={null}
        onStopSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const cards = screen.getAllByTestId("stop-card");
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Far Stop",
      "Mid Stop",
      "Near Stop",
    ]);
    expect(screen.queryByTestId("stop-distance")).toBeNull();
    for (const card of cards) expect(card.getAttribute("aria-label")).not.toMatch(/away/);
    const list = screen.getByTestId("nearby-stops-list");
    expect(list.getAttribute("aria-label")).not.toMatch(/nearby/i);
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

  describe("without a usable location", () => {
    const GROUPS = [NEAR_GROUP, MID_GROUP, FAR_GROUP];

    it("offers Use my location with its purpose, and a stop filter", () => {
      render(<NearbyStopsList groups={GROUPS} userLocation={null} onStopSelect={vi.fn()} />, { wrapper: Wrapper });
      expect(screen.getByTestId("nearby-no-location").textContent).toMatch(/Choose a stop/);
      const locate = screen.getByRole("button", { name: "Use my location" });
      expect(locate.getAttribute("aria-describedby")).toBeTruthy();
      fireEvent.click(locate);
      expect(geo.requestLocation).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Find a stop")).toBeTruthy();
    });

    it("says the location is unavailable after a failure, and hides the button when GPS is off", () => {
      geo.error = "User denied Geolocation";
      useSettingsStore.setState({ gpsMode: "disabled" });
      render(<NearbyStopsList groups={GROUPS} userLocation={null} onStopSelect={vi.fn()} />, { wrapper: Wrapper });
      expect(screen.getByTestId("nearby-no-location").textContent).toMatch(/unavailable/);
      expect(screen.queryByRole("button", { name: "Use my location" })).toBeNull();
    });

    it("filters stops by name and reports no match", () => {
      render(<NearbyStopsList groups={GROUPS} userLocation={null} onStopSelect={vi.fn()} />, { wrapper: Wrapper });
      fireEvent.change(screen.getByLabelText("Find a stop"), { target: { value: "mid" } });
      expect(screen.getAllByTestId("stop-card")).toHaveLength(1);
      fireEvent.change(screen.getByLabelText("Find a stop"), { target: { value: "zzz" } });
      expect(screen.getByText(/No stop matches/)).toBeTruthy();
    });

    it("makes a chosen stop the centre: nearest first from it, named, and changeable", () => {
      const onStopSelect = vi.fn();
      const view = render(<NearbyStopsList groups={GROUPS} userLocation={null} onStopSelect={onStopSelect} />, { wrapper: Wrapper });
      fireEvent.click(screen.getAllByTestId("stop-card").find((c) => c.getAttribute("aria-label")?.startsWith("Far Stop"))!);
      expect(onStopSelect).toHaveBeenCalledWith(FAR_GROUP);
      expect(useNearbyAnchorStore.getState().anchor).toMatchObject({ name: "Far Stop", location: { lat: FAR_GROUP.lat, lon: FAR_GROUP.lon } });

      view.rerender(<NearbyStopsList groups={GROUPS} userLocation={null} onStopSelect={onStopSelect} />);
      expect(screen.getByTestId("nearby-stops-list").getAttribute("aria-label")).toBe("Stops near Far Stop");
      const cards = screen.getAllByTestId("stop-card");
      expect(cards[0].getAttribute("aria-label")).toMatch(/^Far Stop/);
      expect(screen.getAllByTestId("stop-distance").length).toBe(3);

      fireEvent.click(screen.getByTestId("nearby-change-area"));
      expect(useNearbyAnchorStore.getState().anchor).toBeNull();
      expect(screen.getByLabelText("Find a stop")).toBeTruthy();
    });

    it("leaves the anchor alone when the user's position is known", () => {
      render(<NearbyStopsList groups={GROUPS} userLocation={USER_LOCATION} onStopSelect={vi.fn()} />, { wrapper: Wrapper });
      expect(screen.queryByTestId("nearby-chooser")).toBeNull();
      fireEvent.click(screen.getAllByTestId("stop-card")[0]);
      expect(useNearbyAnchorStore.getState().anchor).toBeNull();
    });
  });
});
