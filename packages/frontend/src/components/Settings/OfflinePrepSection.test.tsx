import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OfflinePrepSection } from "./OfflinePrepSection.tsx";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

vi.mock("../../services/poiFetchMode.ts", () => ({
  resolvePoiFetchMode: () => "eager-bundle",
}));

afterEach(cleanup);
beforeEach(() => {
  usePrivacyStore.getState().reset();
});

describe("OfflinePrepSection", () => {
  test("states plainly that live departures are not warmed", () => {
    render(<OfflinePrepSection />);
    expect(screen.getByText(/Live departures need a connection/i)).toBeTruthy();
  });

  test("asks before downloading at Baseline", async () => {
    await usePrivacyStore.getState().setLevel("baseline");
    render(<OfflinePrepSection />);
    fireEvent.click(screen.getByRole("button", { name: /prepare for offline/i }));
    // It must explain, and not have started downloading yet.
    expect(
      screen.getByText(/avoids downloading data you have not asked for/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /download now/i })).toBeTruthy();
  });

  test("carries an accessible section name", () => {
    render(<OfflinePrepSection />);
    expect(
      screen.getByRole("region", { name: /prepare for offline/i }),
    ).toBeTruthy();
  });
});
