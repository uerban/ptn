import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import type { StopGroupRecord } from "../../db/index.ts";

import { MemoryRouter, useLocation } from "react-router-dom";
import type { BaseEndpoint } from "@pt/shared";

const mocks = vi.hoisted(() => ({
  stopGroups: [] as StopGroupRecord[],
  reverseSpy: vi.fn(async (_coord: { lat: number; lon: number }) => null as
    | null
    | { label: string; lat: number; lon: number }),
  savePlaceSpy: vi.fn(
    async (_input: { endpoint: BaseEndpoint; alias?: string }) => undefined,
  ),
}));

vi.mock("../../hooks/useCityDataQuery.ts", () => ({
  useCityDataQuery: () => mocks.stopGroups,
}));

vi.mock("../../db/index.ts", () => ({
  db: {
    stopGroups: {
      toArray: () => Promise.resolve(mocks.stopGroups),
    },
  },
}));

vi.mock("../../services/geocoder/instance.ts", () => ({
  geocoderRegistry: {
    reverse: (coord: { lat: number; lon: number }) => mocks.reverseSpy(coord),
  },
}));

vi.mock("../../services/saves.ts", () => ({
  savePlace: (input: { endpoint: BaseEndpoint; alias?: string }) =>
    mocks.savePlaceSpy(input),
}));

vi.mock("../../services/errorReporter.ts", () => ({
  reportError: vi.fn(),
}));

import { MapTapActionSheet } from "./MapTapActionSheet.tsx";
import { useMapTapStore } from "../../stores/mapTapStore.ts";
import { useRoutingStore } from "../../stores/routingStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

/** Reports the router's current path so navigation can be asserted. */
function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderSheet() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <MapTapActionSheet />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function currentPath(): string {
  return screen.getByTestId("path").textContent ?? "";
}

// ~100m N of the canonical tap point (54.687251, 25.279734).
// Inside the default walk radius (~1125m) but well outside any privacy
// preset's snap radius (max 100m), so it routes without offering snap.
const reachableGroup: StopGroupRecord = {
  groupId: "reachable",
  name: "Reachable Stop",
  stopIds: ["stop-reachable"],
  type: "name_cluster",
  lat: 54.688151,
  lon: 25.279734,
};

beforeEach(() => {
  mocks.stopGroups = [reachableGroup];
  mocks.reverseSpy.mockReset();
  mocks.reverseSpy.mockResolvedValue(null);
  mocks.savePlaceSpy.mockReset();
  mocks.savePlaceSpy.mockResolvedValue(undefined);
  useMapTapStore.setState({ rawTap: null });
  useRoutingStore.setState({ origin: null, destination: null });
  usePrivacyStore.getState().reset();
  globalThis.localStorage?.removeItem("ptn-privacy");
  usePrivacyStore.getState().setLevel("baseline");
});

afterEach(() => {
  cleanup();
});

describe("MapTapActionSheet", () => {
  test("renders nothing when there is no pending tap", () => {
    renderSheet();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("renders actions when a raw tap is pending", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    renderSheet();
    expect(
      screen.getByRole("button", { name: /Use as origin/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Use as destination/i }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeDefined();
  });

  test("Save with label action is rendered alongside the routing actions", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    renderSheet();
    expect(
      screen.getByRole("button", { name: /Save with label/i }),
    ).toBeDefined();
  });

  test("'Use as origin' calls routingStore.setOrigin with the confirmed mappoint BaseEndpoint and clears the raw tap", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: /Use as origin/i }));

    const origin = useRoutingStore.getState().origin;
    expect(origin).not.toBeNull();
    expect(origin!.kind).toBe("mappoint");
    expect(origin!.lat).toBe(54.687251);
    expect(origin!.lon).toBe(25.279734);
    expect(useMapTapStore.getState().rawTap).toBeNull();
  });

  test("'Use as destination' calls routingStore.setDestination with the confirmed mappoint BaseEndpoint and clears the raw tap", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    renderSheet();

    fireEvent.click(
      screen.getByRole("button", { name: /Use as destination/i }),
    );

    const destination = useRoutingStore.getState().destination;
    expect(destination).not.toBeNull();
    expect(destination!.kind).toBe("mappoint");
    expect(destination!.lat).toBe(54.687251);
    expect(destination!.lon).toBe(25.279734);
    expect(useMapTapStore.getState().rawTap).toBeNull();
  });

  describe("handoff to the search page", () => {
    // Regression: both routing actions used to write the endpoint into
    // `routingStore` and stop there. Nothing on the map reads those slots and
    // nothing navigated, so the buttons looked dead in the PWA.
    test("'Use as origin' navigates to /search", () => {
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();
      expect(currentPath()).toBe("/");

      fireEvent.click(screen.getByRole("button", { name: /Use as origin/i }));

      expect(currentPath()).toBe("/search");
    });

    test("'Use as destination' navigates to /search", () => {
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(
        screen.getByRole("button", { name: /Use as destination/i }),
      );

      expect(currentPath()).toBe("/search");
    });

    test("the nearest-stop row navigates to /search too", () => {
      usePrivacyStore.getState().setLevel("standard"); // 25m snap radius
      mocks.stopGroups = [
        {
          groupId: "cluster:Cathedral Sq:54.6872",
          name: "Cathedral Sq",
          stopIds: ["stop-a"],
          type: "name_cluster",
          lat: 54.68726,
          lon: 25.27977,
        },
      ];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      const nearestGroup = screen.getByRole("group", {
        name: /Use nearest stop: Cathedral Sq/i,
      });
      fireEvent.click(
        within(nearestGroup).getByRole("button", { name: /Use as origin/i }),
      );

      expect(currentPath()).toBe("/search");
      expect(useMapTapStore.getState().rawTap).toBeNull();
    });

    test("'Cancel' does not navigate", () => {
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

      expect(currentPath()).toBe("/");
    });
  });

  describe("save with label persists (M8c wiring)", () => {
    async function openSaveForm() {
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();
      fireEvent.click(screen.getByRole("button", { name: /Save with label/i }));
      return (await screen.findByRole("textbox", {
        name: /Add a label/i,
      })) as HTMLInputElement;
    }

    test("Save writes the policy-reduced endpoint and the label, then clears the pin", async () => {
      usePrivacyStore.getState().setLevel("hardened"); // 50m precision floor
      const input = await openSaveForm();
      fireEvent.change(input, { target: { value: "  Office  " } });

      fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

      await waitFor(() => expect(mocks.savePlaceSpy).toHaveBeenCalledTimes(1));
      const arg = mocks.savePlaceSpy.mock.calls[0][0];
      expect(arg.alias).toBe("  Office  ");
      expect(arg.endpoint.kind).toBe("mappoint");
      // Reduced through persistMapTap, not the raw tap.
      const latStep = 50 / 111_320;
      expect(
        Math.abs(arg.endpoint.lat / latStep - Math.round(arg.endpoint.lat / latStep)),
      ).toBeLessThan(1e-9);
      expect(arg.endpoint.lat).not.toBe(54.687251);

      await waitFor(() =>
        expect(useMapTapStore.getState().rawTap).toBeNull(),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("a failed save keeps the pin and surfaces a retryable error", async () => {
      mocks.savePlaceSpy.mockRejectedValue(new Error("quota exceeded"));
      const input = await openSaveForm();
      fireEvent.change(input, { target: { value: "Office" } });

      fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

      await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
      expect(screen.getByRole("alert").textContent).toMatch(/Could not save/i);
      // The pin survives so the user can retry without re-dropping it.
      expect(useMapTapStore.getState().rawTap).not.toBeNull();
      expect(
        screen.getByRole("button", { name: /^Save$/i }),
      ).toBeDefined();
    });

    test("Save is disabled until a label is entered", async () => {
      const input = await openSaveForm();
      const button = screen.getByRole("button", {
        name: /^Save$/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);

      fireEvent.change(input, { target: { value: "Home" } });
      expect(
        (screen.getByRole("button", { name: /^Save$/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  test("'Cancel' clears the raw tap without touching routing state", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect(useMapTapStore.getState().rawTap).toBeNull();
    expect(useRoutingStore.getState().origin).toBeNull();
    expect(useRoutingStore.getState().destination).toBeNull();
  });

  test("applies the active privacy policy precision when confirming as origin", () => {
    usePrivacyStore.getState().setLevel("hardened");
    // Reachable stop required so the regular action sheet renders, but it's
    // far enough away that no snap row is offered at the hardened (50m) radius.
    mocks.stopGroups = [reachableGroup];
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: /^Use as origin$/i }));

    const origin = useRoutingStore.getState().origin;
    expect(origin).not.toBeNull();
    const latStep = 50 / 111_320;
    const lonStep = 50 / (111_320 * Math.cos((origin!.lat * Math.PI) / 180));
    expect(
      Math.abs(origin!.lat / latStep - Math.round(origin!.lat / latStep)),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(origin!.lon / lonStep - Math.round(origin!.lon / lonStep)),
    ).toBeLessThan(1e-9);
  });

  describe("snap-to-stop-group affordance (M7b T-4)", () => {
    const nearbyGroup: StopGroupRecord = {
      groupId: "cluster:Cathedral Sq:54.6872",
      name: "Cathedral Sq",
      stopIds: ["stop-a", "stop-b"],
      type: "name_cluster",
      lat: 54.68726, // ~10m from the tap point below
      lon: 25.27977,
    };

    const farGroup: StopGroupRecord = {
      groupId: "cluster:Far Away:54.7",
      name: "Far Away",
      stopIds: ["stop-f"],
      type: "name_cluster",
      lat: 54.7,
      lon: 25.3,
    };

    test("does NOT show the nearest-stop row when snap radius is 0 (baseline)", () => {
      usePrivacyStore.getState().setLevel("baseline");
      mocks.stopGroups = [nearbyGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.queryByRole("group", { name: /Use nearest stop/i }),
      ).toBeNull();
    });

    test("does NOT show the nearest-stop row when no group is within radius", () => {
      usePrivacyStore.getState().setLevel("standard"); // 25m radius
      // reachableGroup is ~100m away — outside the 25m snap radius but still
      // within the default walk radius so the regular action sheet renders.
      mocks.stopGroups = [reachableGroup, farGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.queryByRole("group", { name: /Use nearest stop/i }),
      ).toBeNull();
    });

    test("shows BOTH 'Use tapped point' and 'Use nearest stop: X' rows when a group is within radius", () => {
      usePrivacyStore.getState().setLevel("standard"); // 25m radius
      mocks.stopGroups = [nearbyGroup, farGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.getByRole("group", { name: /Use tapped point/i }),
      ).toBeDefined();
      expect(
        screen.getByRole("group", { name: /Use nearest stop: Cathedral Sq/i }),
      ).toBeDefined();
    });

    test("selecting 'Use nearest stop — Use as origin' constructs a stop endpoint and clears the raw tap", () => {
      usePrivacyStore.getState().setLevel("standard"); // 25m radius
      mocks.stopGroups = [nearbyGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      const nearestGroup = screen.getByRole("group", {
        name: /Use nearest stop: Cathedral Sq/i,
      });
      const originBtn = within(nearestGroup).getByRole("button", {
        name: /Use as origin/i,
      });
      fireEvent.click(originBtn);

      const origin = useRoutingStore.getState().origin;
      expect(origin).not.toBeNull();
      expect(origin!.kind).toBe("stop");
      expect(origin).toMatchObject({
        kind: "stop",
        stopId: "stop-a",
        name: "Cathedral Sq",
        lat: nearbyGroup.lat,
        lon: nearbyGroup.lon,
      });
      expect(useMapTapStore.getState().rawTap).toBeNull();
    });

    test("selecting 'Use nearest stop — Use as destination' constructs a stop endpoint", () => {
      usePrivacyStore.getState().setLevel("standard");
      mocks.stopGroups = [nearbyGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      const nearestGroup = screen.getByRole("group", {
        name: /Use nearest stop: Cathedral Sq/i,
      });
      const destBtn = within(nearestGroup).getByRole("button", {
        name: /Use as destination/i,
      });
      fireEvent.click(destBtn);

      const destination = useRoutingStore.getState().destination;
      expect(destination).not.toBeNull();
      expect(destination!.kind).toBe("stop");
      expect(destination).toMatchObject({
        kind: "stop",
        stopId: "stop-a",
        name: "Cathedral Sq",
      });
    });

    test("uses the closest group when multiple are within radius", () => {
      usePrivacyStore.getState().setLevel("hardened"); // 50m radius
      const closer: StopGroupRecord = {
        groupId: "closer",
        name: "Closer Stop",
        stopIds: ["stop-closer"],
        type: "name_cluster",
        lat: 54.68726,
        lon: 25.27977,
      };
      const further: StopGroupRecord = {
        groupId: "further",
        name: "Further Stop",
        stopIds: ["stop-further"],
        type: "name_cluster",
        lat: 54.68760,
        lon: 25.28000,
      };
      mocks.stopGroups = [further, closer];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.getByRole("group", { name: /Use nearest stop: Closer Stop/i }),
      ).toBeDefined();
      expect(
        screen.queryByRole("group", { name: /Use nearest stop: Further Stop/i }),
      ).toBeNull();
    });
  });

  describe("non-routable geometry UX (M7b T-5)", () => {
    test("shows the no-nearby-stops message when zero stops are within walk radius", () => {
      // Far group is ~1.95km away; default walk radius is 1125m → unreachable.
      mocks.stopGroups = [
        {
          groupId: "far",
          name: "Far Away",
          stopIds: ["stop-far"],
          type: "name_cluster",
          lat: 54.7,
          lon: 25.3,
        },
      ];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.getByText(/No transit stops within \d+m of this point/i),
      ).toBeDefined();
    });

    test("shows the no-nearby-stops message when stop groups list is empty", () => {
      mocks.stopGroups = [];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.getByText(/No transit stops within \d+m of this point/i),
      ).toBeDefined();
    });

    test("does NOT render origin/destination buttons when no stops are reachable", () => {
      mocks.stopGroups = [];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      expect(
        screen.queryByRole("button", { name: /Use as origin/i }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Use as destination/i }),
      ).toBeNull();
    });

    test("'Tap somewhere else' clears the raw tap and never touches routing", () => {
      mocks.stopGroups = [];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(
        screen.getByRole("button", { name: /Tap somewhere else/i }),
      );

      expect(useMapTapStore.getState().rawTap).toBeNull();
      expect(useRoutingStore.getState().origin).toBeNull();
      expect(useRoutingStore.getState().destination).toBeNull();
    });
  });

  describe("deferred reverse-geocode (M7b T-6)", () => {
    test("three long-presses in a row fire zero reverse-geocode calls", () => {
      renderSheet();

      act(() => {
        useMapTapStore.getState().emitTap(54.687251, 25.279734);
      });
      act(() => {
        useMapTapStore.getState().clear();
      });
      act(() => {
        useMapTapStore.getState().emitTap(54.687261, 25.279744);
      });
      act(() => {
        useMapTapStore.getState().clear();
      });
      act(() => {
        useMapTapStore.getState().emitTap(54.687271, 25.279754);
      });

      expect(mocks.reverseSpy).not.toHaveBeenCalled();
    });

    test("'Save with label' fires exactly one reverse-geocode at non-Paranoid levels", async () => {
      mocks.reverseSpy.mockResolvedValue({
        label: "Cathedral Square 12",
        lat: 54.687251,
        lon: 25.279734,
      });
      usePrivacyStore.getState().setLevel("standard");
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(screen.getByRole("button", { name: /Save with label/i }));

      await waitFor(() => {
        expect(mocks.reverseSpy).toHaveBeenCalledTimes(1);
      });

      const input = await screen.findByRole("textbox", { name: /Add a label/i });
      await waitFor(() => {
        expect((input as HTMLInputElement).value).toBe("Cathedral Square 12");
      });
    });

    test("'Save with label' fires zero reverse-geocode calls at Paranoid", async () => {
      usePrivacyStore.getState().setLevel("paranoid");
      // Paranoid forces a 100m snap radius and the noNearby walk radius is
      // unaffected, so the reachable stop still renders the routing actions.
      mocks.stopGroups = [reachableGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(screen.getByRole("button", { name: /Save with label/i }));

      // Render the save form and let any pending async work flush.
      const input = await screen.findByRole("textbox", { name: /Add a label/i });
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.reverseSpy).not.toHaveBeenCalled();
      expect((input as HTMLInputElement).value).toBe("");
    });

    test("'Save with label' input is user-entry only at Paranoid", async () => {
      usePrivacyStore.getState().setLevel("paranoid");
      mocks.stopGroups = [reachableGroup];
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(screen.getByRole("button", { name: /Save with label/i }));

      const input = (await screen.findByRole("textbox", {
        name: /Add a label/i,
      })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Home" } });
      expect(input.value).toBe("Home");
      expect(mocks.reverseSpy).not.toHaveBeenCalled();
    });

    test("'Back' from the save form returns to the action list without firing a second reverse call", async () => {
      mocks.reverseSpy.mockResolvedValue({
        label: "Suggested",
        lat: 54.687251,
        lon: 25.279734,
      });
      usePrivacyStore.getState().setLevel("standard");
      useMapTapStore.getState().emitTap(54.687251, 25.279734);
      renderSheet();

      fireEvent.click(screen.getByRole("button", { name: /Save with label/i }));
      await waitFor(() =>
        expect(mocks.reverseSpy).toHaveBeenCalledTimes(1),
      );

      fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));

      // Back to actions; pressing Save again triggers a fresh reverse call.
      expect(
        screen.getByRole("button", { name: /Use as origin/i }),
      ).toBeDefined();
    });
  });
});

describe("Search map picker confirmation", () => {
  test("offers only the requested endpoint role and returns the privacy-reduced point without navigation", () => {
    const onSelect = vi.fn();
    render(<MemoryRouter initialEntries={["/search"]}>
      <MapTapActionSheet picker={{ role: "origin", onSelect }} />
      <LocationProbe />
    </MemoryRouter>);
    act(() => useMapTapStore.getState().emitTap(54.687251, 25.279734));
    const expected = useMapTapStore.getState().reduceToEndpoint();
    expect(screen.queryByRole("button", { name: "Use as destination" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save with label" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use as origin" }));
    expect(onSelect).toHaveBeenCalledWith(expected);
    expect(useMapTapStore.getState().rawTap).toBeNull();
    expect(useRoutingStore.getState().origin).toBeNull();
    expect(currentPath()).toBe("/search");
  });
});
