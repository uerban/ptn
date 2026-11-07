import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CarriedOverOverrides } from "./CarriedOverOverrides.tsx";
import { classifyInstallation } from "../../services/installClassifier.ts";
import { readOnboardingRecord } from "../../services/onboardingRecord.ts";
import {
  applyPendingOnboardingJournal,
  useOnboardingStore,
} from "../../stores/onboardingStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

afterEach(() => cleanup());

beforeEach(async () => {
  localStorage.clear();
  usePrivacyStore.getState().reset();
  useOnboardingStore.setState({ record: null });
  localStorage.clear();
  localStorage.setItem(
    "ptn-privacy",
    JSON.stringify({ state: { level: "strict", overrides: {} }, version: 0 }),
  );
  classifyInstallation(localStorage, 1);
  await usePrivacyStore.persist.rehydrate();
  await applyPendingOnboardingJournal();
});

describe("CarriedOverOverrides", () => {
  test("labels a carried-over protection and lets the user remove it", () => {
    const { getByText, getByRole, container } = render(<CarriedOverOverrides />);
    expect(getByText("Carried over from your previous settings")).toBeTruthy();
    expect(container.textContent).toContain("Carried over");

    fireEvent.click(getByRole("button", { name: /Remove/ }));
    expect(usePrivacyStore.getState().overrides.m11TileDefense).toBeUndefined();
    const read = readOnboardingRecord();
    expect(read.status === "ok" && read.record.legacyOverrides).toEqual({});
    expect(container.textContent).toBe("");
  });

  test("disappears when the level drops below strict", async () => {
    const { container } = render(<CarriedOverOverrides />);
    expect(container.textContent).not.toBe("");
    await act(async () => {
      await usePrivacyStore.getState().setLevel("standard");
    });
    expect(container.textContent).toBe("");
  });

  test("renders nothing for installations without carried-over protections", () => {
    useOnboardingStore.setState({
      record: { ...useOnboardingStore.getState().record!, legacyOverrides: {} },
    });
    const { container } = render(<CarriedOverOverrides />);
    expect(container.textContent).toBe("");
  });
});
