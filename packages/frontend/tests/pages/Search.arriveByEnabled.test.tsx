// With the opt-in gate (as the PTN_ARRIVE_BY_EXPERIMENT=1 alias gives it),
// Search draws the Arrive-by choice and keeps its normal results until a
// deadline is applied.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";

vi.mock("../../src/components/ArriveBy/arriveByEntry.ts", async () =>
  await import("../../src/components/ArriveBy/arriveByEntry.arriveBy.ts"));

describe("Search with the arrive-by experiment", () => {
  it("shows Leave now and Arrive by, Leave now chosen", () => {
    render(
      <MemoryRouter initialEntries={["/search?toLat=54.7&toLon=25.3&toName=Somewhere"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("arrive-by-toolbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave now" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("arrive-by-results")).not.toBeInTheDocument();
  });
});
