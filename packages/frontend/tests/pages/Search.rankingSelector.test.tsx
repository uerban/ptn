import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

describe("Search ranking selector", () => {
  beforeEach(() => {
    useRoutingStore.setState({ ranking: "fastest", results: [], error: null, loading: false });
  });

  it("renders all three ranking buttons", () => {
    renderSearch();
    expect(screen.getByText("Fastest")).toBeInTheDocument();
    expect(screen.getByText("Fewest transfers")).toBeInTheDocument();
    expect(screen.getByText("Least walking")).toBeInTheDocument();
  });

  it("highlights the active ranking", () => {
    renderSearch();
    const fastestBtn = screen.getByText("Fastest");
    expect(fastestBtn).toHaveAttribute("aria-selected", "true");

    const fewestBtn = screen.getByText("Fewest transfers");
    expect(fewestBtn).toHaveAttribute("aria-selected", "false");
  });

  it("updates store when clicking a different ranking", () => {
    renderSearch();
    fireEvent.click(screen.getByText("Fewest transfers"));
    expect(useRoutingStore.getState().ranking).toBe("fewest_transfers");
  });

  it("updates store to least_walking", () => {
    renderSearch();
    fireEvent.click(screen.getByText("Least walking"));
    expect(useRoutingStore.getState().ranking).toBe("least_walking");
  });

  it("reflects store changes in button styling", () => {
    useRoutingStore.setState({ ranking: "least_walking" });
    renderSearch();
    const leastWalkingBtn = screen.getByText("Least walking");
    expect(leastWalkingBtn).toHaveAttribute("aria-selected", "true");

    const fastestBtn = screen.getByText("Fastest");
    expect(fastestBtn).toHaveAttribute("aria-selected", "false");
  });
});
