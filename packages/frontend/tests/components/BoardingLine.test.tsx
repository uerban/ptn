import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import type { Itinerary } from "@pt/shared";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";
import { deriveBoarding } from "../../src/components/RouteResults/shared/boarding.ts";
import { toSegments } from "../../src/components/RouteResults/shared/legHelpers.ts";
import {
  useSettingsStore,
  type RouteSearchVariant,
} from "../../src/stores/settingsStore.ts";
import { place, ride, walk, itinerary as build } from "./shared-fixtures.ts";

/**
 * The visible half of the boarding fix. Two results can leave at the same
 * minute from stops a few hundred metres apart; the card named the line and
 * the alight stop but never the boarding stop, so on screen the pair was
 * indistinguishable. The walking total further down is not a substitute — it
 * names no stop, and with a transfer it is not the access distance either.
 */

function fromPin(stop: string, meters: number, line: string): Itinerary {
  const base = build([
    walk({
      from: place("Dropped pin"),
      to: place(stop, 1, 1, "b"),
      depart: "2026-03-03T09:58:00Z",
      arrive: "2026-03-03T10:00:00Z",
      meters,
    }),
    ride({
      from: place(stop, 1, 1, "b"),
      to: place("Justiniškės", 2, 2, "j"),
      depart: "2026-03-03T10:00:00Z",
      arrive: "2026-03-03T10:11:00Z",
      routeShortName: line,
    }),
  ]);
  return { ...base, walkingDistanceMeters: meters };
}

const atStop: Itinerary = build([
  ride({
    from: place("Stop A", 0, 0, "a"),
    to: place("Stop B", 1, 1, "b"),
    depart: "2026-03-03T10:00:00Z",
    arrive: "2026-03-03T10:15:00Z",
    routeShortName: "42",
  }),
]);

describe("deriveBoarding", () => {
  it("reports the stop and distance when the trip starts elsewhere", () => {
    expect(deriveBoarding(toSegments(fromPin("Konstitucijos pr.", 103, "43")))).toEqual({
      stopName: "Konstitucijos pr.",
      meters: 103,
      atOrigin: false,
    });
  });

  it("reports a missing feed distance as null, never as zero metres", () => {
    const it = build([
      walk({ from: place("Origin"), to: place("Buivydiškių st.", 1, 1, "b"), depart: "2026-03-03T09:58:00Z", arrive: "2026-03-03T10:00:00Z" }),
      ride({ from: place("Buivydiškių st.", 1, 1, "b"), to: place("Centras", 2, 2, "c"), depart: "2026-03-03T10:00:00Z", arrive: "2026-03-03T10:20:00Z", routeShortName: "43" }),
    ]);
    expect(deriveBoarding(toSegments(it))).toEqual({
      stopName: "Buivydiškių st.",
      meters: null,
      atOrigin: false,
    });
  });

  it("treats a same-stop-id walk as boarding at the origin", () => {
    const it = build([
      walk({ from: place("Stop A", 0, 0, "a"), to: place("Stop A", 0, 0, "a"), depart: "2026-03-03T09:59:00Z", arrive: "2026-03-03T10:00:00Z", meters: 30 }),
      ride({ from: place("Stop A", 0, 0, "a"), to: place("Stop B", 1, 1, "b"), depart: "2026-03-03T10:00:00Z", arrive: "2026-03-03T10:15:00Z", routeShortName: "9" }),
    ]);
    expect(deriveBoarding(toSegments(it))?.atOrigin).toBe(true);
  });

  it("returns null for a walk-only itinerary", () => {
    const it = build([
      walk({ from: place("Home"), to: place("Office"), depart: "2026-03-03T10:00:00Z", arrive: "2026-03-03T10:12:00Z", meters: 900 }),
    ]);
    expect(deriveBoarding(toSegments(it))).toBeNull();
  });
});

const VARIANTS: RouteSearchVariant[] = ["consumer", "power", "accessible"];

describe.each(VARIANTS)("BoardingLine — variant=%s", (variant) => {
  beforeEach(() => {
    useSettingsStore.setState({ routeSearchVariant: variant });
  });

  function renderResults(itineraries: Itinerary[]) {
    return render(
      <BrowserRouter>
        <RouteResults itineraries={itineraries} onSelect={() => {}} />
      </BrowserRouter>,
    );
  }

  it("shows the boarding stop and distance when there is a walk to it", () => {
    renderResults([fromPin("Konstitucijos pr.", 103, "43")]);
    expect(screen.getByTestId("boarding-line")).toHaveTextContent(
      "From Konstitucijos pr. · 103 m",
    );
  });

  it("separates two same-minute options that board at different stops", () => {
    renderResults([fromPin("Konstitucijos pr.", 103, "43"), fromPin("Perkūnkiemis", 393, "40")]);
    const lines = screen.getAllByTestId("boarding-line").map((n) => n.textContent);
    expect(lines).toEqual([
      "From Konstitucijos pr. · 103 m",
      "From Perkūnkiemis · 393 m",
    ]);
  });

  it("omits the distance the feed never measured", () => {
    renderResults([fromPin("Buivydiškių st.", 0, "43")]);
    const line = screen.getByTestId("boarding-line");
    expect(line).toHaveTextContent("From Buivydiškių st.");
    expect(line.textContent).not.toMatch(/·\s*0\s*m/);
  });

  it("renders nothing when the trip already starts at the boarding stop", () => {
    renderResults([atStop]);
    expect(screen.queryByTestId("boarding-line")).toBeNull();
  });

  it("agrees with the card's accessible name about the stop", () => {
    renderResults([fromPin("Konstitucijos pr.", 103, "43")]);
    const label = screen.getByTestId("itinerary-card").getAttribute("aria-label") ?? "";
    expect(label).toContain("Board at Konstitucijos pr., 103 m");
    expect(screen.getByTestId("boarding-line")).toHaveTextContent("Konstitucijos pr.");
  });
});
