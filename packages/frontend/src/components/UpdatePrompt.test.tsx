import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { __resetUpdatePromptForTests, UpdatePrompt } from "./UpdatePrompt.tsx";

const updateServiceWorker = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    needRefresh: [true, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker,
  }),
}));

beforeEach(() => {
  __resetUpdatePromptForTests();
});

afterEach(() => {
  cleanup();
  updateServiceWorker.mockClear();
});

describe("UpdatePrompt", () => {
  it("is a polite status, not an alert", () => {
    render(<UpdatePrompt />);
    const prompt = screen.getByTestId("update-prompt");
    expect(prompt.getAttribute("role")).toBe("status");
    expect(prompt.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(prompt.textContent).toContain("A new version is available.");
  });

  it("Update activates the waiting version", () => {
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("Not now hides it for the rest of the session", () => {
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
    expect(updateServiceWorker).not.toHaveBeenCalled();
    cleanup();
    render(<UpdatePrompt />);
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });
});
