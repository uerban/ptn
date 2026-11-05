import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";
import type { BaseEndpoint, Itinerary } from "@pt/shared";
import { db } from "../../src/db/index.ts";
import {
  __resetInstallKeyCacheForTests,
} from "../../src/services/installKey.ts";
import { __resetDegradedModeForTests } from "../../src/services/installKeyDegrade.ts";
import { __clearRamStoreForTests } from "../../src/services/cryptoBox.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";

function makeItinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    legs: [
      {
        mode: "BUS",
        from: { name: "Stop A", location: { lat: 54.68, lon: 25.28 } },
        to: { name: "Stop B", location: { lat: 54.69, lon: 25.29 } },
        departureTime: "2026-03-03T10:00:00Z",
        arrivalTime: "2026-03-03T10:15:00Z",
        durationSeconds: 900,
        routeShortName: "42",
      },
    ],
    departureTime: "2026-03-03T10:00:00Z",
    arrivalTime: "2026-03-03T10:15:00Z",
    durationSeconds: 900,
    transfers: 0,
    walkingDistanceMeters: 200,
    ...overrides,
  };
}

describe("RouteResults", () => {
  it("shows loading skeleton when loading", () => {
    const { container } = render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={() => {}} loading={true} />
      </BrowserRouter>
    );
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(3);
  });

  it("shows empty message when no itineraries", () => {
    render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={() => {}} loading={false} />
      </BrowserRouter>
    );
    expect(screen.getByText(/no routes found/i)).toBeInTheDocument();
  });

  it("renders itinerary cards with duration", () => {
    const itinerary = makeItinerary({ durationSeconds: 1800 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("30 min")).toBeInTheDocument();
  });

  it("renders transfer count", () => {
    const itinerary = makeItinerary({ transfers: 2 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("2 transfers")).toBeInTheDocument();
  });

  it("uses singular 'transfer' for exactly 1", () => {
    const itinerary = makeItinerary({ transfers: 1 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("1 transfer")).toBeInTheDocument();
  });

  it("shows walking distance when present", () => {
    const itinerary = makeItinerary({ walkingDistanceMeters: 350 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("350 m walk")).toBeInTheDocument();
  });

  it("shows route short name", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("shows transport mode icon", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByLabelText("Bus")).toBeInTheDocument();
  });

  it("calls onSelect when clicking an itinerary", () => {
    const onSelect = vi.fn();
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={onSelect} />
      </BrowserRouter>
    );
    // Cards are plain buttons inside a <ul role="list"> (US-037); they are
    // NOT listbox options — see the RouteResults keydown comment.
    fireEvent.click(screen.getByTestId("itinerary-card"));
    expect(onSelect).toHaveBeenCalledWith(itinerary);
  });

  it("renders multiple itineraries", () => {
    const itineraries = [
      makeItinerary({ transfers: 0 }),
      makeItinerary({ transfers: 1 }),
      makeItinerary({ transfers: 2 }),
    ];
    render(
      <BrowserRouter>
        <RouteResults itineraries={itineraries} onSelect={() => {}} />
      </BrowserRouter>
    );
    // Each card is a <li>-wrapped button inside the results list.
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByTestId("itinerary-card")).toHaveLength(3);
  });

  it("shows headsign next to route name for transit legs", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "142",
          headsign: "Central Station",
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("142")).toBeInTheDocument();
    expect(screen.getByText(/Central Station/)).toBeInTheDocument();
  });

  it("does not show headsign for WALK legs", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:05:00Z",
          durationSeconds: 300,
          headsign: "Should Not Appear",
        },
      ],
      transfers: 0,
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.queryByText(/Should Not Appear/)).not.toBeInTheDocument();
  });

  it("does not show headsign arrow when headsign is absent", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    // Single-leg itinerary with no headsign: no → characters should appear
    // (→ is used for leg separators and headsign arrows, neither applies here)
    // The card's time row uses \u2192 (\u2192) as the depart\u2192arrive separator
    // per spec (matches Power/Accessible variants), so we assert specifically
    // that the headsign-arrow text doesn't appear, not that \u2192 is absent
    // from the card entirely. The headsign arrow renders as "\u203a <headsign>"
    // (chevron + space + headsign) \u2014 not the time-row's surrounding spaces.
    const headsignSpans = screen.queryAllByText((_content, el) => {
      return el?.tagName === "SPAN" && /^\u203a\s\S/.test(el.textContent ?? "");
    });
    expect(headsignSpans).toHaveLength(0);
  });

  it("truncates long headsigns with title attribute", () => {
    const longHeadsign = "Very Long Destination Name That Should Be Truncated";
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "TRAM",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "3",
          headsign: longHeadsign,
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const headsignEl = screen.getByTitle(longHeadsign);
    expect(headsignEl).toBeInTheDocument();
    expect(headsignEl).toHaveClass("truncate");
  });

  it("renders multi-leg itinerary with mode arrows", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:05:00Z",
          durationSeconds: 300,
        },
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:05:00Z",
          arrivalTime: "2026-03-03T10:20:00Z",
          durationSeconds: 900,
          routeShortName: "7",
        },
      ],
      transfers: 0,
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByLabelText("Walk")).toBeInTheDocument();
    expect(screen.getByLabelText("Bus")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("renders transit leg with colored route badge using routeColor", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "99",
          routeColor: "#e63946",
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const badge = screen.getByTestId("route-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveStyle({ backgroundColor: "#e63946" });
    expect(screen.getByText("99")).toBeInTheDocument();
  });

  it("renders walk leg badge with duration in minutes", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:07:00Z",
          durationSeconds: 420,
        },
      ],
      transfers: 0,
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const badge = screen.getByTestId("route-badge");
    expect(badge).toBeInTheDocument();
    expect(screen.getByText("7 min")).toBeInTheDocument();
  });

  it("uses chevron arrows between multi-leg badges", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:05:00Z",
          durationSeconds: 300,
        },
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:05:00Z",
          arrivalTime: "2026-03-03T10:20:00Z",
          durationSeconds: 900,
          routeShortName: "7",
        },
      ],
      transfers: 0,
    });
    const { container } = render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    // chevron › (U+203A) or › should appear between legs
    const chevrons = container.querySelectorAll("[data-testid='leg-chevron']");
    expect(chevrons.length).toBe(1);
  });

  it("shows eco-score when legs have distance data with savings", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "TRAM",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "3",
          distanceMeters: 5000,
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const ecoEl = screen.getByTestId("eco-score");
    expect(ecoEl).toBeInTheDocument();
    // Tram: 5km * 20 = 100g, Car: 5km * 120 = 600g, savings = 83%
    expect(ecoEl.textContent).toContain("83%");
  });

  it("does not show eco-score when legs have no distance data", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.queryByTestId("eco-score")).not.toBeInTheDocument();
  });
});

describe("RouteResults — Save this pair", () => {
  const origin: BaseEndpoint = {
    kind: "stop",
    stopId: "O",
    name: "Origin Stop",
    lat: 0,
    lon: 0,
  };
  const destination: BaseEndpoint = {
    kind: "stop",
    stopId: "D",
    name: "Dest Stop",
    lat: 1,
    lon: 1,
  };

  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    __clearRamStoreForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    usePrivacyStore.getState().reset();
    vi.spyOn(window, "prompt").mockReturnValue("");
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("hides the save-pair button when origin is missing", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(
      screen.queryByRole("button", { name: /save this pair/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the save-pair button when destination is missing", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
        />
      </BrowserRouter>,
    );
    expect(
      screen.queryByRole("button", { name: /save this pair/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the save-pair button when there are no itineraries", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(
      screen.queryByRole("button", { name: /save this pair/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the save-pair button when both endpoints are defined", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(
      screen.getByRole("button", { name: /save this pair/i }),
    ).toBeInTheDocument();
  });

  it("writes a savedLocations row when the button is clicked", async () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    const saveBtn = screen.getByRole("button", { name: /save this pair/i });
    fireEvent.click(saveBtn);
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const rows = await db.savedLocations.toArray();
    expect(rows[0]!.destinationEndpoint).toBeDefined();
    await waitFor(() => {
      expect(saveBtn).toBeDisabled();
    });
    expect(saveBtn.textContent).toMatch(/saved/i);
  });

  it("uses the prompt value as the alias", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Home → Work");
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /save this pair/i }));
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const rows = await db.savedLocations.toArray();
    expect(rows[0]!.alias).toBe("Home → Work");
  });

  it("shows the sensitive checkbox at Baseline, unchecked by default", async () => {
    await usePrivacyStore.getState().setLevel("baseline", {
      confirm: () => true,
    });
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    const box = screen.getByTestId("save-pair-sensitive") as HTMLInputElement;
    expect(box).toBeInTheDocument();
    expect(box.checked).toBe(false);
  });

  it("shows the sensitive checkbox at Standard, checked by default", () => {
    // Standard is the default level after reset().
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    const box = screen.getByTestId("save-pair-sensitive") as HTMLInputElement;
    expect(box).toBeInTheDocument();
    expect(box.checked).toBe(true);
  });

  it("hides the sensitive checkbox at Hardened (axis forces encryption)", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(screen.queryByTestId("save-pair-sensitive")).not.toBeInTheDocument();
  });

  it("writes an encrypted row when sensitive is checked at Baseline", async () => {
    await usePrivacyStore.getState().setLevel("baseline", {
      confirm: () => true,
    });
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByTestId("save-pair-sensitive"));
    fireEvent.click(screen.getByRole("button", { name: /save this pair/i }));
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.encrypted).toBe(true);
    expect(JSON.stringify(row)).not.toContain("Origin Stop");
  });

  it("writes a plaintext row when sensitive is unchecked at Standard", async () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByTestId("save-pair-sensitive"));
    fireEvent.click(screen.getByRole("button", { name: /save this pair/i }));
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const row = (await db.savedLocations.toArray())[0]!;
    expect(row.encrypted).toBe(false);
    expect(row.endpoint).toEqual(origin);
    expect(row.destinationEndpoint).toEqual(destination);
  });
});

describe("RouteResults — appearance shortcut placement", () => {
  it("puts the Appearance link below the results, not above the first card", () => {
    const { container } = render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          onEarlier={() => {}}
          onLater={() => {}}
        />
      </BrowserRouter>,
    );
    const link = screen.getByRole("link", { name: /appearance/i });
    const firstCard = screen.getAllByTestId("itinerary-card")[0];
    // It used to own a full-width row at the top of the list, costing a row of
    // result space on every search for a control almost nobody taps.
    expect(
      firstCard.compareDocumentPosition(link) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and it sits after the pagination controls, which are the footer's
    // primary action.
    const later = screen.getByRole("button", { name: /later/i });
    expect(
      later.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it("renders no appearance row at all when there are no results", () => {
    render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={() => {}} />
      </BrowserRouter>,
    );
    expect(screen.queryByRole("link", { name: /appearance/i })).toBeNull();
  });
});
