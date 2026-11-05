import { describe, test, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { PolicyAxisControl } from "./PolicyAxisControl.tsx";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  usePrivacyStore.getState().reset();
});

describe("PolicyAxisControl", () => {
  test("renders current effective value as checked", () => {
    // standard floor for mapTapPersistedPrecision = "snap-centroid"
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
      />,
    );
    const checked = screen.getByRole("radio", { checked: true }) as HTMLInputElement;
    expect(checked.value).toBe("snap-centroid");
  });

  test("options above floor are interactive", () => {
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
      />,
    );
    const snap100 = screen.getByRole("radio", {
      name: /snap-rounded-100m$/,
    }) as HTMLInputElement;
    expect(snap100.disabled).toBe(false);
  });

  test("options below floor are disabled with lock copy", () => {
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
      />,
    );
    const rawOption = screen.getByRole("radio", { name: /raw/ }) as HTMLInputElement;
    expect(rawOption.disabled).toBe(true);
    const rawLabel = rawOption.closest("label");
    expect(rawLabel?.textContent ?? "").toMatch(/Locked/i);
  });

  test("selecting stricter option calls setOverride", () => {
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
      />,
    );
    const strict = screen.getByRole("radio", {
      name: /snap-rounded-100m$/,
    }) as HTMLInputElement;
    fireEvent.click(strict);
    expect(usePrivacyStore.getState().overrides.mapTapPersistedPrecision).toBe(
      "snap-rounded-100m",
    );
  });

  test("selecting at-floor option calls clearOverride", () => {
    // seed an override above the floor first
    usePrivacyStore
      .getState()
      .setOverride("mapTapPersistedPrecision", "snap-rounded-100m");
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
      />,
    );
    const floor = screen.getByRole("radio", { name: /^snap-centroid$/ }) as HTMLInputElement;
    fireEvent.click(floor);
    expect(
      "mapTapPersistedPrecision" in usePrivacyStore.getState().overrides,
    ).toBe(false);
  });
});

describe("PolicyAxisControl interceptChange", () => {
  test("interceptChange resolves false → setOverride NOT called, radio reverts visually", async () => {
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
        interceptChange={async () => false}
      />,
    );
    const strict = screen.getByRole("radio", {
      name: /snap-rounded-100m$/,
    }) as HTMLInputElement;
    fireEvent.click(strict);
    await waitFor(() => {
      // setOverride was NOT called — store value stays at floor (snap-centroid)
      expect(
        usePrivacyStore.getState().overrides.mapTapPersistedPrecision,
      ).toBeUndefined();
      // The prior (floor) option's radio is checked; the clicked one is not
      const priorRadio = screen.getByRole("radio", {
        name: /^snap-centroid$/,
      }) as HTMLInputElement;
      const clickedRadio = screen.getByRole("radio", {
        name: /snap-rounded-100m$/,
      }) as HTMLInputElement;
      expect(priorRadio.checked).toBe(true);
      expect(clickedRadio.checked).toBe(false);
    });
  });

  test("interceptChange resolves true → setOverride IS called", async () => {
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
        interceptChange={async () => true}
      />,
    );
    const strict = screen.getByRole("radio", {
      name: /snap-rounded-100m$/,
    }) as HTMLInputElement;
    fireEvent.click(strict);
    await waitFor(() => {
      expect(
        usePrivacyStore.getState().overrides.mapTapPersistedPrecision,
      ).toBe("snap-rounded-100m");
    });
  });

  test("without interceptChange, clicking applies immediately (sanity)", () => {
    render(
      <PolicyAxisControl
        axis="mapTapPersistedPrecision"
        i18nKeyPrefix="privacy.axis.mapTapPersistedPrecision"
      />,
    );
    const strict = screen.getByRole("radio", {
      name: /snap-rounded-100m$/,
    }) as HTMLInputElement;
    fireEvent.click(strict);
    expect(
      usePrivacyStore.getState().overrides.mapTapPersistedPrecision,
    ).toBe("snap-rounded-100m");
  });
});
