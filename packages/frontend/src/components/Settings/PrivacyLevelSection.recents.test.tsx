import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

vi.mock("../../services/recents.ts", async (o) => ({
  ...(await o<typeof import("../../services/recents.ts")>()),
  countRecents: vi.fn(),
  clearRecents: vi.fn().mockResolvedValue(undefined),
}));
import { countRecents, clearRecents } from "../../services/recents.ts";

// Import after the mock so the component picks up mocked recents.ts
import { PrivacyLevelSection } from "./PrivacyLevelSection.tsx";

afterEach(() => {
  cleanup();
  // Vitest 4's restoreAllMocks only restores vi.spyOn spies; resetAllMocks
  // is what clears the mocked recents.ts fns between cases.
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  usePrivacyStore.getState().reset();
  vi.mocked(clearRecents).mockResolvedValue(undefined);
});

/**
 * Clicks the "off" radio for the recentsEncryption axis and returns the input.
 * The axis control renders all values in strictness order; "off" is the last
 * option (index 5) in AXIS_STRICTNESS_ORDER.recentsEncryption.
 */
function clickRecentsOffRadio(): HTMLInputElement {
  const radio = screen.getByRole("radio", {
    name: /^off$/,
  }) as HTMLInputElement;
  fireEvent.click(radio);
  return radio;
}

describe("PrivacyLevelSection — recents Off-switch", () => {
  test("countRecents=3, confirm=true: clearRecents called AND override applied", async () => {
    vi.mocked(countRecents).mockResolvedValue(3);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<PrivacyLevelSection />);
    clickRecentsOffRadio();

    await waitFor(() => {
      expect(clearRecents).toHaveBeenCalledTimes(1);
      // Override was applied: axis is "off" in the store
      expect(usePrivacyStore.getState().overrides.recentsEncryption).toBe("off");
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The confirm message should contain the count
    expect(confirmSpy.mock.calls[0]![0]).toContain("3");
  });

  test("countRecents=3, confirm=false: neither clearRecents nor override applied, radio reverts", async () => {
    vi.mocked(countRecents).mockResolvedValue(3);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<PrivacyLevelSection />);
    const offRadio = clickRecentsOffRadio();

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      // clearRecents must NOT have been called
      expect(clearRecents).not.toHaveBeenCalled();
      // Override must NOT have been applied — axis stays at store default
      expect(usePrivacyStore.getState().overrides.recentsEncryption).toBeUndefined();
      // The radio should have reverted (not checked)
      expect(offRadio.checked).toBe(false);
    });
  });

  test("countRecents=0: no confirm, override applied silently", async () => {
    vi.mocked(countRecents).mockResolvedValue(0);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<PrivacyLevelSection />);
    clickRecentsOffRadio();

    await waitFor(() => {
      // Override applied
      expect(usePrivacyStore.getState().overrides.recentsEncryption).toBe("off");
      // clearRecents still called (purge is safe even when count=0)
      expect(clearRecents).toHaveBeenCalledTimes(1);
    });

    // window.confirm must NOT have been shown when count is 0
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
