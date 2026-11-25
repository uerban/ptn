// With the opt-in gate (as the PTN_ARRIVE_BY_EXPERIMENT=1 alias gives it),
// Search draws the Arrive-by choice and keeps its normal results until a
// deadline is applied.
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { useArriveByUi } from "../../src/components/ArriveBy/arriveByUiStore.ts";
import { SearchPage } from "../../src/pages/Search.tsx";

vi.mock("../../src/components/ArriveBy/arriveByEntry.ts", async () =>
  await import("../../src/components/ArriveBy/arriveByEntry.arriveBy.ts"));

describe("Search with the arrive-by experiment", () => {
  it("shows the time summary; opened, Leave (chosen) and Arrive by", () => {
    render(
      <MemoryRouter initialEntries={["/search?toLat=54.7&toLon=25.3&toName=Somewhere"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("arrive-by-toolbar")).toBeInTheDocument();
    // Folded by default: one summary button, so the header stays short.
    expect(screen.queryByRole("button", { name: "Arrive by" })).not.toBeInTheDocument();
    expect(screen.getByTestId("when-summary")).toHaveTextContent("When: Now (Leave now)");
    fireEvent.click(screen.getByTestId("when-summary"));
    expect(screen.getByRole("button", { name: "Leave" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("arrive-by-results")).not.toBeInTheDocument();
  });
  it("shows the selected sort as a tie-breaker once an Arrive by deadline is applied", () => {
    render(
      <MemoryRouter initialEntries={["/search?toLat=54.7&toLon=25.3&toName=Somewhere"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "From" }), {
      target: { value: "54.68, 25.28" },
    });
    expect(screen.getByTestId("sort-summary")).toHaveAccessibleName("Sort: Fastest");

    act(() => {
      useArriveByUi.getState().chooseArriveBy(Date.now() + 60 * 60 * 1000);
      useArriveByUi.getState().apply();
    });

    expect(screen.getByTestId("sort-summary")).toHaveAccessibleName("Tie-breaker: Fastest");
    fireEvent.click(screen.getByTestId("sort-summary"));
    expect(screen.getByText(/breaks departure-time ties between the remaining journeys/i)).toBeInTheDocument();

    act(() => useArriveByUi.getState().chooseLeaveNow());
  });

});
