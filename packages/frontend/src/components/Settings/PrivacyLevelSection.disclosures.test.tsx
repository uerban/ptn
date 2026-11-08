import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrivacyLevelSection } from "./PrivacyLevelSection.tsx";

// Disclosures used to sit in one "How this affects your data" wall at the
// bottom of the privacy screen, detached from the knobs they describe. Each
// one now hangs off its own axis control, collapsed behind a "Full detail"
// expander, with the axis description acting as the always-visible summary.
// The only level-wide disclosure, atRest, is intro copy under the level
// picker instead.

/** disclosure text -> the control (axis or network flow) it must be attached to */
const ATTACHED: { needle: RegExp; axisTitle: string; flowGroup?: string }[] = [
  { needle: /Shareable URLs can carry coordinates/i, axisTitle: "URL share & deep links" },
  { needle: /per-install key/i, axisTitle: "Recent locations" },
  { needle: /coordinate saved into recents is snapped/i, axisTitle: "Map tap precision" },
  { needle: /Geocoder providers are tried in order/i, axisTitle: "Provider fallback" },
  { needle: /internal error reports are buffered/i, axisTitle: "Error reporting" },
  // Network disclosures hang off the decision row of their flow.
  {
    needle: /Dedup cache reduces third-party calls/i,
    axisTitle: "Third-party place search",
    flowGroup: "external.place-search@nominatim",
  },
];

describe("per-axis disclosures", () => {
  test("the standalone disclosures section is gone", () => {
    render(<PrivacyLevelSection />);
    expect(screen.queryByText(/How this affects your data/i)).toBeNull();
  });

  test("atRest is intro copy, not tucked in an expander", () => {
    render(<PrivacyLevelSection />);
    const intro = screen.getByText(/stored in this browser/i);
    expect(intro.closest("details")).toBeNull();
  });

  test("place data traffic is explained with the level, not under a map provider", () => {
    render(<PrivacyLevelSection />);
    const details = screen.getByText(/area-of-interest tiles from the PTN backend/i).closest("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.closest("[data-flow-group]")).toBeNull();
  });

  for (const { needle, axisTitle, flowGroup } of ATTACHED) {
    test(`"${axisTitle}" carries its own disclosure`, () => {
      render(<PrivacyLevelSection />);
      const text = screen.getByText(needle);
      const details = text.closest("details");
      expect(details, `${axisTitle}: disclosure not in a <details>`).not.toBeNull();
      // Collapsed by default — the summary line is what the user reads first.
      expect(details?.hasAttribute("open")).toBe(false);
      // And it must live under the axis it describes.
      if (flowGroup) {
        expect(details?.closest("[data-flow-group]")?.getAttribute("data-flow-group")).toBe(flowGroup);
      } else {
        expect(details?.closest("[data-axis-group]")?.textContent).toContain(axisTitle);
      }
    });
  }
});
