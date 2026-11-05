import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  LeadingWaitBanner,
  shouldShowLeadingWaitBanner,
} from "../../src/components/RouteResults/shared/LeadingWaitBanner.tsx";

describe("shouldShowLeadingWaitBanner", () => {
  it("returns false at threshold boundary (leadingWait === 5 min when buffer === 3 min)", () => {
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 300,
        bufferSeconds: 180,
        missRisk: false,
        hasLiveDelay: false,
      }),
    ).toBe(false);
  });

  it("returns true above 5-min floor when buffer === 3 min", () => {
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 301,
        bufferSeconds: 180,
        missRisk: false,
        hasLiveDelay: false,
      }),
    ).toBe(true);
  });

  it("uses bufferSeconds + 120 as the floor when wheelchair (5 min) buffer is in effect", () => {
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 419,
        bufferSeconds: 300,
        missRisk: false,
        hasLiveDelay: false,
      }),
    ).toBe(false);
    // Exact boundary
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 420,
        bufferSeconds: 300,
        missRisk: false,
        hasLiveDelay: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 421,
        bufferSeconds: 300,
        missRisk: false,
        hasLiveDelay: false,
      }),
    ).toBe(true);
  });

  it("returns false when missRisk is set (priority: miss > banner)", () => {
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 1800,
        bufferSeconds: 180,
        missRisk: true,
        hasLiveDelay: false,
      }),
    ).toBe(false);
  });

  it("returns false when hasLiveDelay is set (priority: delay > banner)", () => {
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 1800,
        bufferSeconds: 180,
        missRisk: false,
        hasLiveDelay: true,
      }),
    ).toBe(false);
  });

  it("returns false when both missRisk AND hasLiveDelay are set", () => {
    expect(
      shouldShowLeadingWaitBanner({
        leadingWaitSeconds: 1800,
        bufferSeconds: 180,
        missRisk: true,
        hasLiveDelay: true,
      }),
    ).toBe(false);
  });
});

describe("LeadingWaitBanner", () => {
  it("renders 'Next departure in 47 min. Leave at <time>.'", () => {
    // firstTransitDep − referenceNow = 47 min → ceil = 47
    const { getByText } = render(
      <LeadingWaitBanner
        firstTransitDepMs={new Date("2026-04-25T10:54:00Z").getTime()}
        referenceNowMs={new Date("2026-04-25T10:07:00Z").getTime()}
        recommendedDepartureMs={new Date("2026-04-25T10:51:00Z").getTime()}
      />,
    );
    expect(getByText(/47 min/)).toBeInTheDocument();
  });

  it("returns null when firstTransitDepMs <= referenceNowMs (caller should have gated)", () => {
    // Suppress the dev-mode warn so the test output stays clean.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <LeadingWaitBanner
        firstTransitDepMs={new Date("2026-04-25T10:00:00Z").getTime()}
        referenceNowMs={new Date("2026-04-25T10:30:00Z").getTime()}
        recommendedDepartureMs={new Date("2026-04-25T10:30:00Z").getTime()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null on NaN inputs (parseFailed defensive)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <LeadingWaitBanner
        firstTransitDepMs={NaN}
        referenceNowMs={new Date("2026-04-25T10:30:00Z").getTime()}
        recommendedDepartureMs={new Date("2026-04-25T10:30:00Z").getTime()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    warn.mockRestore();
  });
});
