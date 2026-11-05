import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrivacyLevelSection } from "./PrivacyLevelSection.tsx";

// Disclosures used to sit in one "How this affects your data" wall at the
// bottom of the privacy screen, detached from the knobs they describe. Each
// one now hangs off its own axis control, collapsed behind a "Full detail"
// expander, with the axis description acting as the always-visible summary.
// The only level-wide disclosure, atRest, is intro copy under the level
// picker instead.

/** disclosure text -> the axis control it must be attached to */
const ATTACHED: { needle: RegExp; axisTitle: string }[] = [
  { needle: /Shareable URLs can carry coordinates/i, axisTitle: "URL share & deep links" },
  { needle: /per-install encryption key|sealed with a per-install key/i, axisTitle: "Recent locations" },
  { needle: /coordinate saved into recents is snapped/i, axisTitle: "Map tap precision" },
  { needle: /Geocoder providers are tried in order/i, axisTitle: "Provider fallback" },
  { needle: /internal error reports are buffered/i, axisTitle: "Error reporting" },
  { needle: /departure polling has distinct cadences/i, axisTitle: "Real-time polling" },
  { needle: /Dedup cache reduces third-party calls/i, axisTitle: "Third-party geocoding (M10)" },
  { needle: /area-of-interest tiles from the PTN backend/i, axisTitle: "Detailed map" },
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

  for (const { needle, axisTitle } of ATTACHED) {
    test(`"${axisTitle}" carries its own disclosure`, () => {
      render(<PrivacyLevelSection />);
      const text = screen.getByText(needle);
      const details = text.closest("details");
      expect(details, `${axisTitle}: disclosure not in a <details>`).not.toBeNull();
      // Collapsed by default — the summary line is what the user reads first.
      expect(details?.hasAttribute("open")).toBe(false);
      // And it must live under the axis it describes.
      const group = details?.closest("[data-axis-group]");
      expect(group?.textContent).toContain(axisTitle);
    });
  }
});
