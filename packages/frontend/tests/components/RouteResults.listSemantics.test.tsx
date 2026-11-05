import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import type { Itinerary } from "@pt/shared";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";
import {
  useSettingsStore,
  type RouteSearchVariant,
} from "../../src/stores/settingsStore.ts";

/**
 * Screen-reader contract for the results surface.
 *
 * The bug these pin: the wrapper used to declare `role="listbox"` and
 * attribute-mutate `role="option"` onto the variant cards from an effect.
 * None of the options were owned by the listbox (every variant nests its
 * cards under a generic <div>), the wrapper also held content that is illegal
 * inside a listbox, and the roles landed post-paint — so VoiceOver on macOS
 * announced the surface as an empty scrollable list and its suggested
 * interaction selected a nameless item.
 */

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

const VARIANTS: RouteSearchVariant[] = ["consumer", "power", "accessible"];

function renderResults(itineraries: Itinerary[]) {
  return render(
    <BrowserRouter>
      <RouteResults itineraries={itineraries} onSelect={() => {}} />
    </BrowserRouter>,
  );
}

describe.each(VARIANTS)("RouteResults list semantics — variant=%s", (variant) => {
  beforeEach(() => {
    useSettingsStore.setState({ routeSearchVariant: variant });
  });

  it("exposes the results as a named list with one item per itinerary", () => {
    renderResults([makeItinerary(), makeItinerary(), makeItinerary()]);
    const list = screen.getByRole("list", { name: "Route results" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("declares role=list explicitly (Tailwind's list-style:none strips it in WebKit)", () => {
    const { container } = renderResults([makeItinerary()]);
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    expect(ul).toHaveAttribute("role", "list");
  });

  it("is not a listbox and the cards are not options", () => {
    renderResults([makeItinerary(), makeItinerary()]);
    expect(screen.queryAllByRole("listbox")).toHaveLength(0);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    for (const card of screen.getAllByTestId("itinerary-card")) {
      expect(card).not.toHaveAttribute("aria-selected");
    }
  });

  it("keeps every card in the tab order — no roving tabindex", () => {
    renderResults([makeItinerary(), makeItinerary(), makeItinerary()]);
    for (const card of screen.getAllByTestId("itinerary-card")) {
      expect(card.tabIndex).toBe(0);
    }
  });

  it("names each card from an author-supplied label, not the visual content dump", () => {
    renderResults([makeItinerary()]);
    const card = screen.getByTestId("itinerary-card");
    const label = card.getAttribute("aria-label") ?? "";
    // Index 0 is the fastest result in every variant; the ranking cue and the
    // leg chain come before the trip's duration and cost.
    expect(label.startsWith("Fastest.")).toBe(true);
    // The fixture boards where the trip starts, so the short form fires.
    expect(label).toContain("Board here");
    expect(label.indexOf("Bus 42 to Stop B")).toBeLessThan(
      label.indexOf("0 transfers"),
    );
    // Reachable by accessible name — i.e. the label really is the AX name.
    expect(
      screen.getByRole("button", { name: /^Fastest\. Board here\. Bus 42 to Stop B/ }),
    ).toBe(card);
  });

  it("moves focus between cards on ArrowDown/ArrowUp", () => {
    renderResults([makeItinerary(), makeItinerary(), makeItinerary()]);
    const cards = screen.getAllByTestId("itinerary-card");
    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[0]);
    // Wraps at the ends.
    fireEvent.keyDown(cards[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[2]);
  });

  it("leaves arrow keys alone when focus is outside the card list", () => {
    renderResults([makeItinerary(), makeItinerary()]);
    const later = document.createElement("button");
    document.body.appendChild(later);
    later.focus();
    fireEvent.keyDown(screen.getAllByTestId("itinerary-card")[0], {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(later);
    later.remove();
  });
});
