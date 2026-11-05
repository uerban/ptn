import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { I18nContext } from "../../src/i18n/index.ts";
import { Layout } from "../../src/components/Layout/Layout.tsx";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";
import { BottomSheet } from "../../src/components/Layout/BottomSheet.tsx";
import type { Itinerary } from "@pt/shared";

const mockT = (_: string, fallback?: string) => fallback ?? _;

function I18nWrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nContext.Provider
      value={{ locale: "en", formattingLocale: "en", t: mockT }}
    >
      {children}
    </I18nContext.Provider>
  );
}

function makeItinerary(transfers = 0): Itinerary {
  return {
    legs: [
      {
        mode: "BUS",
        from: { name: "Stop A", location: { lat: 0, lon: 0 } },
        to: { name: "Stop B", location: { lat: 0, lon: 0 } },
        departureTime: "2026-04-25T10:00:00Z",
        arrivalTime: "2026-04-25T10:15:00Z",
        durationSeconds: 900,
        routeShortName: "42",
      },
    ],
    departureTime: "2026-04-25T10:00:00Z",
    arrivalTime: "2026-04-25T10:15:00Z",
    durationSeconds: 900,
    transfers,
    walkingDistanceMeters: 0,
  };
}

describe("Keyboard navigation — RouteResults", () => {
  /**
   * These used to assert listbox/option semantics with a roving tabindex.
   * That shape was invalid — the options were never owned by the listbox, the
   * wrapper also carried content illegal inside one, and the roles were
   * written post-paint from an effect — and macOS VoiceOver read the surface
   * as an empty scrollable list. The cards are navigation targets, so they are
   * now <li>-wrapped buttons in a real list, all of them tabbable.
   */
  function renderResults(
    itineraries: Itinerary[],
    onSelect: (it: Itinerary) => void = () => {},
  ) {
    return render(
      <BrowserRouter>
        <I18nWrapper>
          <RouteResults itineraries={itineraries} onSelect={onSelect} />
        </I18nWrapper>
      </BrowserRouter>,
    );
  }

  it("exposes the results as a named list, not a listbox", () => {
    renderResults([makeItinerary(0), makeItinerary(1), makeItinerary(2)]);

    const list = screen.getByRole("list", { name: "Route results" });
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryAllByRole("listbox")).toHaveLength(0);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("keeps every card in the tab order — no roving tabindex", () => {
    renderResults([makeItinerary(0), makeItinerary(1), makeItinerary(2)]);
    const cards = screen.getAllByTestId("itinerary-card");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.tabIndex).toBe(0);
      expect(card).not.toHaveAttribute("aria-selected");
    }
  });

  it("names each card from an urgency-ordered summary, not the visual dump", () => {
    renderResults([makeItinerary(1)]);
    const card = screen.getByTestId("itinerary-card");
    const name = card.getAttribute("aria-label") ?? "";
    // Ranking cue and what to board come before duration and cost, so a
    // screen-reader user can act without hearing the whole card.
    expect(name.startsWith("Fastest. Board here. Bus 42 to Stop B.")).toBe(true);
    expect(name.indexOf("Bus 42")).toBeLessThan(name.indexOf("1 transfer"));
  });

  it("ArrowDown moves focus to the next card, wrapping at the end", () => {
    renderResults([makeItinerary(0), makeItinerary(1), makeItinerary(2)]);
    const cards = screen.getAllByTestId("itinerary-card");

    cards[0].focus();
    expect(document.activeElement).toBe(cards[0]);

    fireEvent.keyDown(cards[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(cards[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[2]);

    // Wraps back to the first card.
    fireEvent.keyDown(cards[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[0]);
  });

  it("ArrowUp moves focus to the previous card, wrapping at the start", () => {
    renderResults([makeItinerary(0), makeItinerary(1), makeItinerary(2)]);
    const cards = screen.getAllByTestId("itinerary-card");

    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[2]);

    fireEvent.keyDown(cards[2], { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[1]);
  });

  it("activating a focused card triggers onSelect for that itinerary", () => {
    const onSelect = vi.fn();
    const itineraries = [makeItinerary(0), makeItinerary(1)];
    renderResults(itineraries, onSelect);

    const cards = screen.getAllByTestId("itinerary-card");
    cards[0].focus();
    // Native <button> activation — Enter and Space are the browser's job,
    // which is exactly why these are buttons and not listbox options.
    fireEvent.click(cards[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(itineraries[0]);
  });
});

describe("Keyboard navigation — Skip link", () => {
  it("skip link is the first focusable element on the page", () => {
    render(
      <BrowserRouter>
        <I18nWrapper>
          <Layout />
        </I18nWrapper>
      </BrowserRouter>,
    );

    const skipLink = screen.getByTestId("skip-link");
    expect(skipLink).toBeInTheDocument();
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    // Skip link is the first focusable element in document order.
    const focusable = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable[0]).toBe(skipLink);
  });

  it("skip link targets a main landmark with id=main-content", () => {
    render(
      <BrowserRouter>
        <I18nWrapper>
          <Layout />
        </I18nWrapper>
      </BrowserRouter>,
    );
    const main = document.querySelector("main#main-content");
    expect(main).not.toBeNull();
  });
});

describe("Keyboard navigation — BottomSheet", () => {
  it("Escape closes the sheet and returns focus to the trigger", () => {
    function TestHarness() {
      const [open, setOpen] = useState(false);
      return (
        <I18nWrapper>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            Open sheet
          </button>
          {open && (
            <BottomSheet
              onClose={() => setOpen(false)}
              ariaLabel="Test sheet"
              data-testid="sheet"
              height="full"
            >
              <button data-sheet-close data-testid="close">
                Close
              </button>
              <button data-testid="action-1">Action 1</button>
              <button data-testid="action-2">Action 2</button>
            </BottomSheet>
          )}
        </I18nWrapper>
      );
    }

    render(<TestHarness />);

    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);

    // On open, focus moves to the close button (data-sheet-close).
    const closeBtn = screen.getByTestId("close");
    expect(document.activeElement).toBe(closeBtn);

    // Escape closes — fire on document since the listener is attached there.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
    // Return focus restores to the original trigger.
    expect(document.activeElement).toBe(trigger);
  });

  it("focus trap activates only when height is full", () => {
    function HalfSheetHarness() {
      return (
        <I18nWrapper>
          <BottomSheet
            onClose={() => {}}
            ariaLabel="Half sheet"
            data-testid="sheet"
            height="half"
          >
            <button data-testid="action-1">Action 1</button>
            <button data-testid="action-2">Action 2</button>
          </BottomSheet>
        </I18nWrapper>
      );
    }

    render(<HalfSheetHarness />);

    // The half sheet renders without aria-modal (no trap).
    const sheet = screen.getByTestId("sheet");
    expect(sheet.getAttribute("aria-modal")).toBeNull();
    expect(sheet.getAttribute("data-sheet-height")).toBe("half");
  });
});
