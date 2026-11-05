/**
 * Renders every route-results variant against the real Cyrillic locale files
 * and fails on any English UI word left in the output.
 *
 * The Cyrillic locales are the ones that can be checked mechanically: a Latin
 * word in a Belarusian render is a leak by definition, whereas "min" in
 * Swedish is the real Swedish word. Feed-authored strings — route short
 * names, stop names — stay Latin and are excluded by the token list.
 *
 * The all-caps "LIVE" badge is excluded too, but for a different reason:
 * i18n-glossary.json marks it doNotTranslate so the badge keeps a known
 * size in every locale, which makes an English "LIVE" the intended render
 * rather than a leak. Title-case "Live" stays in the list — it opens real
 * prose (route.live_prefix, route.may_miss) that every locale translates.
 *
 * This is the surface the defect was reported on: the power-user, consumer and
 * accessibility cards rendered "FASTEST / ride 31m / walk 673m / 0 tr / on
 * vehicle / Off at" in every language because none of those keys had ever
 * reached en.json.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { I18nContext, type SupportedLocale } from "../../src/i18n/index.ts";
import { RouteResultsPower } from "../../src/components/RouteResults/RouteResultsPower.tsx";
import { RouteResultsConsumer } from "../../src/components/RouteResults/RouteResultsConsumer.tsx";
import { RouteResultsAccessible } from "../../src/components/RouteResults/RouteResultsAccessible.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import be from "../../src/i18n/locales/be.json";
import ru from "../../src/i18n/locales/ru.json";
import uk from "../../src/i18n/locales/uk.json";
import type { Itinerary, Leg } from "@pt/shared";

const CYRILLIC: Record<string, Record<string, string>> = { be, ru, uk };

// Every English UI word the three variants can emit. A feed-authored token
// ("3G", a stop name) is not in this list and is expected to stay Latin.
const ENGLISH_UI =
  /\b(FASTEST|STEP-FREE|TIGHT|MISS|SCHED|SCHEDULED|ON TIME|ride|walk|tr|stop|stops|transfer|transfers|on vehicle|Off at|DEP|ARR|LEGS|TOTAL|min|wait|Live|running|may miss)\b/;

function wrapper(locale: SupportedLocale, table: Record<string, string>) {
  const t = (key: string, fallback?: string) => table[key] ?? fallback ?? key;
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nContext.Provider
        value={{
          locale,
          formattingLocale: locale,
          t,
          privacyReady: true,
          ensurePrivacyNamespace: () => {},
        }}
      >
        {children}
      </I18nContext.Provider>
    );
  };
}

const walkLeg = {
  mode: "WALK",
  from: { name: "Origin", location: { lat: 0, lon: 0 } },
  to: { name: "Jurgio Baltrusaicio st.", location: { lat: 0, lon: 0 } },
  departureTime: "2026-03-28T22:29:00Z",
  arrivalTime: "2026-03-28T22:41:00Z",
  durationSeconds: 660,
  distanceMeters: 673,
} as Leg;

const busLeg = {
  mode: "BUS",
  routeShortName: "3G",
  routeColor: "00853e",
  intermediateStops: 11,
  from: { name: "Jurgio Baltrusaicio st.", location: { lat: 0, lon: 0 } },
  to: { name: "Eisiskiu plentas", location: { lat: 0, lon: 0 } },
  departureTime: "2026-03-28T22:41:00Z",
  arrivalTime: "2026-03-28T23:12:00Z",
  durationSeconds: 1860,
} as Leg;

const itinerary: Itinerary = {
  legs: [walkLeg, busLeg],
  departureTime: "2026-03-28T22:29:00Z",
  arrivalTime: "2026-03-28T23:19:00Z",
  durationSeconds: 3000,
  transfers: 0,
  walkingDistanceMeters: 673,
};

const VARIANTS = {
  power: RouteResultsPower,
  consumer: RouteResultsConsumer,
  accessible: RouteResultsAccessible,
} as const;

describe("route results leak no English into a Cyrillic locale", () => {
  const cases = Object.keys(CYRILLIC).flatMap((locale) =>
    Object.keys(VARIANTS).map((variant) => [locale, variant] as const),
  );

  it.each(cases)("%s / %s", (locale, variant) => {
    useSettingsStore.setState({ mobilityProfile: "default" });
    const Variant = VARIANTS[variant as keyof typeof VARIANTS];
    const { container } = render(
      <Variant
        itineraries={[itinerary]}
        onSelect={() => {}}
        referenceNowMs={0}
        bufferSeconds={0}
      />,
      { wrapper: wrapper(locale as SupportedLocale, CYRILLIC[locale]) },
    );
    expect(screen.getAllByTestId("itinerary-card")).toHaveLength(1);
    const leak = ENGLISH_UI.exec(container.textContent ?? "");
    expect(
      leak?.[0],
      `${locale}/${variant} rendered the English word "${leak?.[0]}"`,
    ).toBeUndefined();
  });

  it.each(Object.keys(CYRILLIC))(
    "%s labels every segment of the timeline bar in-locale",
    (locale) => {
      const { container } = render(
        <RouteResultsConsumer
          itineraries={[itinerary]}
          onSelect={() => {}}
          referenceNowMs={0}
          bufferSeconds={0}
        />,
        { wrapper: wrapper(locale as SupportedLocale, CYRILLIC[locale]) },
      );
      const bar = container.querySelector("[data-testid='itinerary-bar']");
      expect(bar).not.toBeNull();
      expect(bar?.getAttribute("aria-label")).not.toMatch(ENGLISH_UI);
      for (const seg of container.querySelectorAll(
        "[data-testid='itinerary-bar-segment']",
      )) {
        expect(seg.getAttribute("title")).not.toMatch(ENGLISH_UI);
      }
    },
  );
});
