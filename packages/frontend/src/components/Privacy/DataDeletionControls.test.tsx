import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataDeletionControls } from "./DataDeletionControls.tsx";

afterEach(cleanup);

describe("DataDeletionControls", () => {
  it("lists the exact scope and asks before deleting personal history", async () => {
    const confirmFn = vi.fn<(message: string) => boolean>(() => true);
    const deleteHistory = vi.fn(async () => {});
    render(
      <DataDeletionControls
        confirmFn={confirmFn}
        deleteHistory={deleteHistory}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete personal history" }),
    );
    await waitFor(() => expect(deleteHistory).toHaveBeenCalledOnce());
    expect(confirmFn.mock.calls[0]![0]).toMatch(/saved places and journeys/i);
    expect(confirmFn.mock.calls[0]![0]).toMatch(/Downloaded transit data.*stay/i);
    expect(screen.getByRole("status").textContent).toMatch(/deleted/i);
  });

  it("does nothing when confirmation is declined", () => {
    const clearDownloads = vi.fn(async () => {});
    render(
      <DataDeletionControls
        confirmFn={() => false}
        clearDownloads={clearDownloads}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear downloaded public data" }),
    );
    expect(clearDownloads).not.toHaveBeenCalled();
  });

  it("surfaces deletion failures through an accessible inline alert", async () => {
    render(
      <DataDeletionControls
        confirmFn={() => true}
        resetPtn={vi.fn().mockRejectedValue(new Error("blocked"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset PTN completely" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toMatch(/try again/i);
  });
});
