/**
 * Regression cover for the defect class where a `t()` key never reached
 * en.json: the call site renders its inline English fallback, parity stays
 * green, and every locale ships English. These tests drive the real
 * components through a NON-English translator so a string that bypasses
 * `t()` — a hardcoded literal, a unit suffix glued onto a number — shows up
 * as English in the output and fails.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { ModeToggle } from "../../src/components/Map/ModeToggle.tsx";
import { LineBadge } from "../../src/components/RouteResults/shared/LineBadge.tsx";
import { TransportModeIcon } from "../../src/components/TransportModeIcon.tsx";
import { ItineraryBar } from "../../src/components/RouteResults/shared/ItineraryBar.tsx";
import { RouteResultsConsumer } from "../../src/components/RouteResults/RouteResultsConsumer.tsx";
import { computeConnectionStatus } from "../../src/components/Guidance/connectionStatus.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { MODE_PICTOGRAM } from "../../src/utils/modeLabels.ts";
import en from "../../src/i18n/locales/en.json";
import type { Itinerary, Leg, TransportMode } from "@pt/shared";

// Stands in for a real locale: every key resolves to a marked token, so any
// English left in the output came from a literal the component never
// translated.
const TABLE: Record<string, string> = {
  "map.mode_now": "ZZ_NOW",
  "map.mode_all": "ZZ_ALL",
  "map.mode_lookahead_hours": "{hours} ZZ_HOURS",
  "settings.mode_walk": "ZZ_WALK_MODE",
  "settings.mode_bus": "ZZ_BUS_MODE",
  "mode.glyph_bus": "ZZ_B",
  "route.bar_walk": "ZZ_WALK {n}",
  "route.bar_ride": "ZZ_RIDE {line} {n}",
  "route.bar_walk_title": "ZZ_WALK_TITLE {n} {m}",
  "guidance.connection_safe": "ZZ_SAFE {n}",
  "unit.meters": "{n} ZZ_METRES",
  "unit.meters_compact": "{n}ZZ_METRES",
  "unit.minutes_compact": "{n}ZZ_MINUTES",
  "time.min": "ZZ_MIN",
  "route.walk": "ZZ_WALK_VERB",
  "route.transfer_one": "ZZ_TRANSFER",
  "route.transfer_few": "ZZ_TRANSFERS",
  "route.transfer_many": "ZZ_TRANSFERS",
};
const zz = (key: string, fallback?: string) => TABLE[key] ?? fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider
      value={{
        locale: "lt",
        formattingLocale: "lt",
        t: zz,
        privacyReady: true,
        ensurePrivacyNamespace: () => {},
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

describe("urban-mode toggle", () => {
  beforeEach(() => {
    useSettingsStore.setState({ urbanMode: true, urbanLookaheadHours: 2 });
  });

  it("localizes the lookahead suffix instead of gluing an English 'h' on", () => {
    render(<ModeToggle />, { wrapper: Wrapper });
    const button = screen.getByTestId("mode-toggle");
    expect(button).toHaveTextContent("2 ZZ_HOURS");
    expect(button.textContent).not.toMatch(/\b2h\b/);
  });

  it("carries the same token into the accessible name", () => {
    render(<ModeToggle />, { wrapper: Wrapper });
    expect(screen.getByTestId("mode-toggle")).toHaveAccessibleName(
      /ZZ_NOW · 2 ZZ_HOURS/,
    );
  });
});

describe("mode badges", () => {
  it("LineBadge falls back to the localized glyph, not the Latin letter", () => {
    render(<LineBadge mode="BUS" size="sm" />, { wrapper: Wrapper });
    const badge = screen.getByTestId("route-badge");
    expect(badge).toHaveTextContent("ZZ_B");
    expect(badge).toHaveAccessibleName("ZZ_BUS_MODE");
  });

  // Walking has no letter to translate any more: the badge draws the
  // pedestrian pictogram, which is why no `mode.glyph_walk` exists. The mode
  // name still has to be localized — it is the badge's accessible name.
  it("LineBadge draws a pictogram for WALK and keeps the name localized", () => {
    render(<LineBadge mode="WALK" size="sm" />, { wrapper: Wrapper });
    const badge = screen.getByTestId("route-badge");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge).toHaveTextContent("");
    expect(badge).toHaveAccessibleName("ZZ_WALK_MODE");
  });

  it.each(Object.keys(MODE_PICTOGRAM) as TransportMode[])(
    "%s renders a pictogram, never a letter",
    (mode) => {
      const { unmount } = render(<LineBadge mode={mode} size="sm" />, {
        wrapper: Wrapper,
      });
      const badge = screen.getByTestId("route-badge");
      expect(badge.querySelector("svg")).not.toBeNull();
      expect(badge).toHaveTextContent("");
      unmount();
    },
  );

  // A `mode.glyph_*` key for a pictogram mode is dead weight that still costs
  // eleven translations and a row in the review queue.
  it("ships no glyph key for a mode that draws a pictogram", () => {
    const table = en as Record<string, string>;
    for (const mode of Object.keys(MODE_PICTOGRAM)) {
      expect(table[`mode.glyph_${mode.toLowerCase()}`]).toBeUndefined();
    }
  });

  it("LineBadge keeps the feed's route short name untranslated", () => {
    render(<LineBadge mode="BUS" label="3G" routeColor="00853e" />, {
      wrapper: Wrapper,
    });
    const badge = screen.getByTestId("route-badge");
    expect(badge).toHaveTextContent("3G");
    expect(badge).toHaveAccessibleName("ZZ_BUS_MODE");
  });

  it("TransportModeIcon localizes its glyph and its accessible name", () => {
    const { container } = render(<TransportModeIcon mode="BUS" />, {
      wrapper: Wrapper,
    });
    const icon = container.firstElementChild as HTMLElement;
    expect(icon).toHaveTextContent("ZZ_B");
    expect(icon).toHaveAttribute("aria-label", "ZZ_BUS_MODE");
  });
});

describe("itinerary bar accessibility text", () => {
  const itinerary: Itinerary = {
    legs: [
      {
        mode: "WALK",
        from: { name: "A", location: { lat: 0, lon: 0 } },
        to: { name: "B", location: { lat: 0, lon: 0 } },
        departureTime: "2026-03-28T10:00:00Z",
        arrivalTime: "2026-03-28T10:06:00Z",
        durationSeconds: 360,
        distanceMeters: 400,
      } as Leg,
    ],
    departureTime: "2026-03-28T10:00:00Z",
    arrivalTime: "2026-03-28T10:06:00Z",
    durationSeconds: 360,
    transfers: 0,
    walkingDistanceMeters: 400,
  };

  it("announces the shape in the active locale, not in English", () => {
    render(<ItineraryBar itinerary={itinerary} />, { wrapper: Wrapper });
    const bar = screen.getByTestId("itinerary-bar");
    expect(bar).toHaveAccessibleName(/ZZ_WALK 6/);
    expect(bar.getAttribute("aria-label")).not.toMatch(/\bwalk\b/);
  });

  it("titles each segment in the active locale too", () => {
    render(<ItineraryBar itinerary={itinerary} />, { wrapper: Wrapper });
    const segment = within(screen.getByTestId("itinerary-bar")).getAllByTestId(
      "itinerary-bar-segment",
    )[0];
    expect(segment.getAttribute("title")).toMatch(/ZZ_WALK_TITLE/);
  });
});

describe("connection status", () => {
  const at = (iso: string) => iso;
  const legA: Leg = {
    mode: "BUS",
    tripId: "t1",
    from: { name: "A", location: { lat: 0, lon: 0 } },
    to: { name: "B", location: { lat: 0, lon: 0 } },
    departureTime: at("2026-03-28T10:00:00Z"),
    arrivalTime: at("2026-03-28T10:10:00Z"),
    durationSeconds: 600,
  } as Leg;
  const legB: Leg = {
    ...legA,
    tripId: "t2",
    departureTime: at("2026-03-28T10:20:00Z"),
    arrivalTime: at("2026-03-28T10:30:00Z"),
  } as Leg;
  const noDelay = { getTripDelay: () => null };

  it("renders through the translator it is handed", () => {
    const status = computeConnectionStatus(legA, legB, noDelay, zz);
    expect(status?.message).toBe("ZZ_SAFE 10");
  });

  it("still renders English when no translator is supplied", () => {
    const status = computeConnectionStatus(legA, legB, noDelay);
    expect(status?.message).toBe("Connection safe — 10 min buffer");
  });
});

describe("distance and duration units", () => {
  // `time.m` carried BOTH senses: StopPopup used it as a minutes suffix
  // ("5m"), and be/uk translate it "хв" — so reusing it for metres printed
  // "466 хв" for 466 metres. The two senses are now separate keys.
  it("does not share one key between metres and minutes", async () => {
    const en = (await import("../../src/i18n/locales/en.json")).default as Record<string, string>;
    const be = (await import("../../src/i18n/locales/be.json")).default as Record<string, string>;
    expect(en["time.m"]).toBeUndefined();
    expect(en["unit.meters"]).toBe("{n} m");
    expect(en["unit.minutes_compact"]).toBe("{n}m");
    // A locale that spells the minute out must not be reachable from a
    // metres call site.
    expect(be["unit.meters"]).not.toMatch(/хв/);
    expect(be["unit.minutes_compact"]).toMatch(/хв/);
  });

  it("every locale that translates a unit token keeps its {n} slot", async () => {
    // A locale may omit a token whose rendering matches English — the call
    // site's fallback covers it — but a token it DOES carry must keep the
    // slot, or the number vanishes from the UI.
    for (const loc of ["en", "lt", "pl", "be", "ru", "uk", "lv", "et", "sv", "nb", "fi"]) {
      const table = (await import(`../../src/i18n/locales/${loc}.json`)).default as Record<string, string>;
      for (const key of ["unit.meters", "unit.meters_compact", "unit.minutes_compact"]) {
        if (!(key in table)) continue;
        expect(table[key], `${loc} ${key}`).toContain("{n}");
      }
    }
  });

  it("renders the walking distance through the metres token", () => {
    const itinerary: Itinerary = {
      legs: [],
      departureTime: "2026-03-28T10:00:00Z",
      arrivalTime: "2026-03-28T10:06:00Z",
      durationSeconds: 360,
      transfers: 0,
      walkingDistanceMeters: 466,
    };
    render(<RouteResultsConsumer itineraries={[itinerary]} onSelect={() => {}} referenceNowMs={0} bufferSeconds={0} />, {
      wrapper: Wrapper,
    });
    const card = screen.getByTestId("itinerary-card");
    expect(card).toHaveTextContent("466 ZZ_METRES");
    expect(card.textContent).not.toMatch(/466 ZZ_MINUTES/);
  });
});
