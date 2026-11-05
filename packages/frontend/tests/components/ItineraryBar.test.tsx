import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";
import { ItineraryBar } from "../../src/components/RouteResults/shared/ItineraryBar.tsx";
import { makeMixedItinerary } from "../helpers/makeItinerary.ts";

describe("ItineraryBar", () => {
  it("renders exactly one segment per toSegments() output (ride, wait, ride, walk)", () => {
    render(<ItineraryBar itinerary={makeMixedItinerary()} />);
    const segments = screen.getAllByTestId("itinerary-bar-segment");
    expect(segments.length).toBe(4);
  });

  it("hides the progress cursor when progress is null/undefined", () => {
    render(<ItineraryBar itinerary={makeMixedItinerary()} progress={null} />);
    expect(screen.queryByTestId("itinerary-bar-progress")).toBeNull();
  });

  it("shows the progress cursor when progress is finite in [0,1]", () => {
    render(<ItineraryBar itinerary={makeMixedItinerary()} progress={0.5} />);
    expect(screen.getByTestId("itinerary-bar-progress")).toBeInTheDocument();
  });

  it("hides the progress cursor for NaN / Infinity", () => {
    const { rerender } = render(<ItineraryBar itinerary={makeMixedItinerary()} progress={NaN} />);
    expect(screen.queryByTestId("itinerary-bar-progress")).toBeNull();
    rerender(<ItineraryBar itinerary={makeMixedItinerary()} progress={Infinity} />);
    expect(screen.queryByTestId("itinerary-bar-progress")).toBeNull();
  });

  it("root has stable testid", () => {
    render(<ItineraryBar itinerary={makeMixedItinerary()} />);
    expect(screen.getByTestId("itinerary-bar")).toBeInTheDocument();
  });
});

describe("BufferWaitSegment + optional segments prop", () => {
  it("renders a BufferWaitSegment as a striped segment", () => {
    const it = makeMixedItinerary();
    const segments = [
      { kind: "buffer-wait" as const, seconds: 180, atStopName: "A" },
      ...require("../../src/components/RouteResults/shared/legHelpers.ts").toSegments(it),
    ];
    render(<ItineraryBar itinerary={it} segments={segments} />);
    const segElements = screen.getAllByTestId("itinerary-bar-segment");
    // 1 buffer-wait + 4 from makeMixedItinerary's toSegments output = 5
    expect(segElements.length).toBe(5);
  });

  it("describe() (aria-label) includes 'wait Nm at <stop>' for buffer-wait", () => {
    const it = makeMixedItinerary();
    const segments = [
      { kind: "buffer-wait" as const, seconds: 180, atStopName: "Centre Stop" },
      ...require("../../src/components/RouteResults/shared/legHelpers.ts").toSegments(it),
    ];
    render(<ItineraryBar itinerary={it} segments={segments} />);
    const label = screen.getByTestId("itinerary-bar").getAttribute("aria-label") ?? "";
    expect(label).toContain("wait 3 min at Centre Stop");
  });

  it("does not call toSegments internally when segments prop is supplied (regression)", async () => {
    const legHelpers = await import("../../src/components/RouteResults/shared/legHelpers.ts");
    const spy = (await import("vitest")).vi.spyOn(legHelpers, "toSegments");
    const it = makeMixedItinerary();
    const segments = legHelpers.toSegments(it);
    spy.mockClear();
    render(<ItineraryBar itinerary={it} segments={segments} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("aria-hidden prop", () => {
  it("sets aria-hidden=true when ariaHidden prop is set", () => {
    render(<ItineraryBar itinerary={makeMixedItinerary()} ariaHidden />);
    expect(screen.getByTestId("itinerary-bar").getAttribute("aria-hidden")).toBe("true");
  });

  it("does not set aria-hidden by default", () => {
    render(<ItineraryBar itinerary={makeMixedItinerary()} />);
    expect(screen.getByTestId("itinerary-bar").getAttribute("aria-hidden")).toBeNull();
  });
});
