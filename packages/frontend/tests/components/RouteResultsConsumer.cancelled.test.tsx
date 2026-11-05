import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Itinerary } from "@pt/shared";
import { BrowserRouter } from "react-router-dom";
import { RouteResultsConsumer } from "../../src/components/RouteResults/RouteResultsConsumer.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { ms, place, ride, walk, itinerary } from "./shared-fixtures.ts";

const CANCELLED = "rt-warning-banner-cancelled";
const UNRELIABLE = "rt-warning-banner-unreliable";

function makeItinerary(): Itinerary {
  const A = place("Home"),
    B = place("Stop A"),
    C = place("Office");
  return itinerary([
    walk({
      from: A,
      to: B,
      depart: "2026-04-25T10:25:00Z",
      arrive: "2026-04-25T10:30:00Z",
    }),
    ride({
      from: B,
      to: C,
      depart: "2026-04-25T10:30:00Z",
      arrive: "2026-04-25T10:54:00Z",
      routeShortName: "42",
    }),
  ]);
}

function renderWithProviders(node: React.ReactNode) {
  return render(
    <BrowserRouter>
      <I18nProvider>{node}</I18nProvider>
    </BrowserRouter>,
  );
}

function renderList(itineraries: Itinerary[]) {
  return renderWithProviders(
    <RouteResultsConsumer
      itineraries={itineraries}
      onSelect={() => {}}
      referenceNowMs={ms("2026-04-25T10:00:00Z")}
      bufferSeconds={180}
    />,
  );
}

describe("RouteResultsConsumer — RT warning banners", () => {
  it("says cancelled — not 'unreliable timing' — when cancelled === true", () => {
    const it: Itinerary = { ...makeItinerary(), cancelled: true };
    const { getByTestId } = renderList([it]);
    const banner = getByTestId(CANCELLED);
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/cancelled/i);
    // The whole point of the split: a cancellation must not be reported
    // with the hedged wording that used to cover both conditions.
    expect(banner).not.toHaveTextContent(/unreliable/i);
  });

  it("says unreliable timing when only timingUnreliable === true", () => {
    const it: Itinerary = { ...makeItinerary(), timingUnreliable: true };
    const { getByTestId, queryByTestId } = renderList([it]);
    expect(getByTestId(UNRELIABLE)).toHaveTextContent(/unreliable timing/i);
    expect(queryByTestId(CANCELLED)).toBeNull();
  });

  it("shows the cancellation alone when both signals fire", () => {
    const it: Itinerary = {
      ...makeItinerary(),
      cancelled: true,
      timingUnreliable: true,
    };
    const { getByTestId, queryByTestId } = renderList([it]);
    expect(getByTestId(CANCELLED)).toBeInTheDocument();
    expect(queryByTestId(UNRELIABLE)).toBeNull();
  });

  it("renders no banner when neither signal is set", () => {
    const it: Itinerary = {
      ...makeItinerary(),
      cancelled: false,
      timingUnreliable: false,
    };
    const { queryByTestId } = renderList([it]);
    expect(queryByTestId(CANCELLED)).toBeNull();
    expect(queryByTestId(UNRELIABLE)).toBeNull();
  });

  it("unmounts the banner when cancelled flips from true to false", () => {
    const itTrue: Itinerary = { ...makeItinerary(), cancelled: true };
    const itFalse: Itinerary = { ...makeItinerary(), cancelled: false };
    const { getByTestId, queryByTestId, rerender } = renderList([itTrue]);
    expect(getByTestId(CANCELLED)).toBeInTheDocument();
    rerender(
      <BrowserRouter>
        <I18nProvider>
          <RouteResultsConsumer
            itineraries={[itFalse]}
            onSelect={() => {}}
            referenceNowMs={ms("2026-04-25T10:00:00Z")}
            bufferSeconds={180}
          />
        </I18nProvider>
      </BrowserRouter>,
    );
    expect(queryByTestId(CANCELLED)).toBeNull();
  });

  it("tags each entry of a mixed list with its own reason", () => {
    const cancelled: Itinerary = { ...makeItinerary(), cancelled: true };
    const unreliable: Itinerary = { ...makeItinerary(), timingUnreliable: true };
    const normal: Itinerary = { ...makeItinerary() };
    const { getAllByTestId, queryAllByTestId } = renderList([
      cancelled,
      normal,
      unreliable,
      cancelled,
    ]);
    expect(getAllByTestId(CANCELLED)).toHaveLength(2);
    expect(queryAllByTestId(UNRELIABLE)).toHaveLength(1);
  });
});
