import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StopMarker } from "../../src/components/Map/StopMarker.tsx";
import type { LineInfo } from "@pt/shared";

describe("StopMarker", () => {
  const hyphenatedLine: LineInfo = {
    routeId: "r1",
    shortName: "3G-A",
    color: "e53935",
  };

  it("renders route badge with whitespace-nowrap to prevent hyphen line-break", () => {
    const { container } = render(
      <StopMarker
        name="Test Stop"
        lines={[hyphenatedLine]}
        offset={{ dx: 40, dy: -30 }}
      />
    );
    const badge = container.querySelector("span");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("3G-A");
    expect(badge!.className).toContain("whitespace-nowrap");
  });

  it("renders multiple badges each with whitespace-nowrap", () => {
    const lines: LineInfo[] = [
      { routeId: "r1", shortName: "3G-A", color: "e53935" },
      { routeId: "r2", shortName: "N-1", color: "1e88e5" },
      { routeId: "r3", shortName: "12", color: "43a047" },
    ];
    const { container } = render(
      <StopMarker
        name="Multi Stop"
        lines={lines}
        offset={{ dx: 40, dy: -30 }}
      />
    );
    const badges = container.querySelectorAll("span");
    expect(badges.length).toBe(3);
    for (const badge of badges) {
      expect(badge.className).toContain("whitespace-nowrap");
    }
  });

  // iOS HIG / Material Design Accessibility require a minimum 44x44pt tap target on touch screens.
  // The visible station-card varies with name length and badge count, but the *click target* (the
  // element bound to onClick) must guarantee 44pt floors so a single-character stop card on a 360px
  // viewport doesn't slip under the threshold.
  it("station-card click target enforces a 44px minimum hit area", () => {
    const { container } = render(
      <StopMarker
        name="A"
        offset={{ dx: 40, dy: -30 }}
      />
    );
    const card = container.querySelector(".cursor-pointer") as HTMLElement | null;
    expect(card).not.toBeNull();
    // Tailwind utility classes baking in the iOS 44pt floor; switching to
    // a smaller utility (e.g. min-w-8) without updating this assertion is a
    // regression on the mobile-QA blocker.
    expect(card!.className).toContain("min-w-[44px]");
    expect(card!.className).toContain("min-h-[44px]");
  });
});
