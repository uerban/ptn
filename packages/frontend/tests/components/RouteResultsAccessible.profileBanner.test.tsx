import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import type { Itinerary } from "@pt/shared";
import { RouteResultsAccessible } from "../../src/components/RouteResults/RouteResultsAccessible.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

const itinerary: Itinerary = {
  legs: [
    {
      mode: "BUS",
      from: { name: "A", location: { lat: 0, lon: 0 } },
      to: { name: "B", location: { lat: 0, lon: 0 } },
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
};

function renderBanner(profile: "default" | "wheelchair" | "vision_impaired" | "bicycle") {
  useSettingsStore.setState({ mobilityProfile: profile } as never);
  render(
    <BrowserRouter>
      <I18nProvider>
        <RouteResultsAccessible
          itineraries={[itinerary]}
          onSelect={() => {}}
          referenceNowMs={Date.parse("2026-03-03T09:50:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>
    </BrowserRouter>,
  );
  return screen.queryByRole("status");
}

// The banner may say only what the profile does. Wheelchair and bicycle skip
// what the feed marks unusable (GTFS value 2) and keep stops and trips with
// no data; vision impaired filters nothing.
describe("RouteResultsAccessible — profile banner", () => {
  afterEach(() => useSettingsStore.setState({ mobilityProfile: "default" } as never));

  it("shows no banner on the default profile", () => {
    expect(renderBanner("default")).toBeNull();
  });

  it("wheelchair: says unmarked stops may have steps", () => {
    const banner = renderBanner("wheelchair");
    expect(banner).toHaveTextContent("Wheelchair profile");
    expect(banner).toHaveTextContent(
      "Skips stops and vehicles marked not wheelchair accessible. Unmarked ones may still have steps.",
    );
  });

  it("bicycle: says unmarked vehicles may not take bikes", () => {
    const banner = renderBanner("bicycle");
    expect(banner).toHaveTextContent("Bicycle profile");
    expect(banner).toHaveTextContent(
      "Skips vehicles marked as not taking bicycles. Unmarked ones may not take them either.",
    );
  });

  it("vision impaired: claims no filtering and no stop data the app lacks", () => {
    const banner = renderBanner("vision_impaired");
    expect(banner).toHaveTextContent("Vision-impaired profile");
    expect(banner).toHaveTextContent("Walking times use your walking speed, and Run to catch is off.");
    expect(banner?.textContent).not.toMatch(/filtered|tactile/i);
  });

  it("no profile promises more than the feed marks", () => {
    for (const profile of ["wheelchair", "vision_impaired", "bicycle"] as const) {
      const banner = renderBanner(profile);
      expect(banner?.textContent).not.toMatch(/\bonly\b|step-free|friendly|all stops/i);
      cleanup();
    }
  });
});
