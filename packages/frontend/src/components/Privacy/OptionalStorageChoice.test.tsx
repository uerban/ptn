import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePrivacyChoicesStore } from "../../stores/privacyChoicesStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";
import { OptionalStorageChoice } from "./OptionalStorageChoice.tsx";

afterEach(cleanup);

describe("OptionalStorageChoice", () => {
  beforeEach(() => {
    usePrivacyChoicesStore.getState().reset();
    usePrivacyStore.getState().reset();
  });

  it("offers a compact, non-modal Remember or No thanks choice", () => {
    render(
      <OptionalStorageChoice
        category="recents"
        title="Recent places"
        description="Keep them on this browser."
        presentation="contextual"
      />,
    );
    expect(screen.getByRole("button", { name: "Remember" })).toBeDefined();
    expect(screen.getByRole("button", { name: "No thanks" })).toBeDefined();
    expect(document.activeElement).toBe(document.body);
  });

  it("remembers a refusal and does not repeat the contextual offer on remount", () => {
    const view = render(
      <OptionalStorageChoice
        category="recents"
        title="Recent places"
        description="Keep them on this browser."
        presentation="contextual"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));
    expect(usePrivacyChoicesStore.getState().choices.recents).toBe("disabled");
    view.unmount();
    render(
      <OptionalStorageChoice
        category="recents"
        title="Recent places"
        description="Keep them on this browser."
        presentation="contextual"
      />,
    );
    expect(screen.queryByRole("button", { name: "No thanks" })).toBeNull();
  });

  it("withdrawal closes the writer choice before deleting and reports completion", async () => {
    usePrivacyChoicesStore.getState().setChoice("viewport", "enabled");
    const cleanupFn = vi.fn(async () => {
      expect(usePrivacyChoicesStore.getState().choices.viewport).toBe("disabled");
    });
    render(
      <OptionalStorageChoice
        category="viewport"
        title="Map area"
        description="Remember it."
        cleanup={cleanupFn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop remembering" }));
    await waitFor(() => expect(cleanupFn).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toMatch(/deleted/i);
  });

  it("keeps the choice disabled and exposes an accessible error if deletion fails", async () => {
    usePrivacyChoicesStore.getState().setChoice("recents", "enabled");
    render(
      <OptionalStorageChoice
        category="recents"
        title="Recent places"
        description="Remember it."
        cleanup={vi.fn().mockRejectedValue(new Error("blocked"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop remembering" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(usePrivacyChoicesStore.getState().choices.recents).toBe("disabled");
  });

  it("shows policy-disabled storage as paused and cannot enable it", () => {
    usePrivacyStore.setState({ level: "strict" });
    render(
      <OptionalStorageChoice
        category="personalization"
        title="Suggestions"
        description="Personalize them."
      />,
    );
    expect(screen.getByRole("button", { name: "Remember" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/unavailable at your current privacy level/i)).toBeDefined();
  });
});
