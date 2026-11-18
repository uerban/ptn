import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { SearchPage } from "../../src/pages/Search.tsx";

function renderSearch(searchParams = "") {
  const result = render(
    <MemoryRouter initialEntries={[`/search${searchParams}`]}>
      <SearchPage />
    </MemoryRouter>,
  );
  // Route ranking belongs to the journey form, outside the place picker.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  return result;
}

const openSheet = () => {
  fireEvent.click(screen.getByTestId("sort-summary"));
  return within(screen.getByRole("dialog", { name: "Sort" }));
};

describe("Search ranking selector", () => {
  beforeEach(() => {
    useRoutingStore.setState({ ranking: "fastest", results: [], error: null, loading: false });
  });

  it("says the current ranking on one chip and hides the choices until opened", () => {
    renderSearch();
    const chip = screen.getByTestId("sort-summary");
    expect(chip).toHaveAccessibleName("Sort: Fastest");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Fewest transfers")).not.toBeInTheDocument();
  });

  it("offers all three rankings and marks the active one", () => {
    renderSearch();
    const sheet = openSheet();
    expect(screen.getByTestId("sort-summary")).toHaveAttribute("aria-expanded", "true");
    expect(sheet.getByRole("button", { name: "Fastest" })).toHaveAttribute("aria-pressed", "true");
    expect(sheet.getByRole("button", { name: "Fewest transfers" })).toHaveAttribute("aria-pressed", "false");
    expect(sheet.getByRole("button", { name: "Least walking" })).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["Fewest transfers", "fewest_transfers"],
    ["Least walking", "least_walking"],
  ] as const)("picking %s applies it and closes the sheet", (name, ranking) => {
    renderSearch();
    fireEvent.click(openSheet().getByRole("button", { name }));
    expect(useRoutingStore.getState().ranking).toBe(ranking);
    expect(screen.queryByRole("dialog", { name: "Sort" })).not.toBeInTheDocument();
    expect(screen.getByTestId("sort-summary")).toHaveAccessibleName(`Sort: ${name}`);
  });

  it("closing without a choice keeps the ranking", () => {
    renderSearch();
    fireEvent.click(openSheet().getByRole("button", { name: "Close" }));
    expect(useRoutingStore.getState().ranking).toBe("fastest");
    expect(screen.queryByRole("dialog", { name: "Sort" })).not.toBeInTheDocument();
  });

  it("reflects a ranking set elsewhere", () => {
    useRoutingStore.setState({ ranking: "least_walking" });
    renderSearch();
    expect(screen.getByTestId("sort-summary")).toHaveAccessibleName("Sort: Least walking");
    expect(openSheet().getByRole("button", { name: "Least walking" })).toHaveAttribute("aria-pressed", "true");
  });
});
