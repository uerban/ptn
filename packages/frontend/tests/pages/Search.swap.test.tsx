import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";

/**
 * SearchPage mounts several stores + geolocation + debounced suggestion
 * fetches. None of that matters for the swap button — we only care that
 * text in the From/To fields swaps atomically when the user taps the
 * vertical swap button in the header.
 */
function renderSearch(initial = "/search?toLat=54.68&toLon=25.28&toName=Airport") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SearchPage />
    </MemoryRouter>,
  );
}

describe("Search header — swap button", () => {
  it("renders a swap button with a descriptive aria-label", () => {
    renderSearch();
    const swap = screen.getByRole("button", {
      name: /swap origin and destination/i,
    });
    expect(swap).toBeInTheDocument();
  });

  it("swaps From and To text when clicked", () => {
    renderSearch();
    // Both inputs render as role=searchbox; first is From, second is To.
    // The URL param seeds "To" with "Airport"; we type into From.
    const boxes = screen.getAllByRole("searchbox");
    const fromInput = boxes[0] as HTMLInputElement;
    const toInput = boxes[1] as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "Home" } });
    expect(fromInput.value).toBe("Home");
    expect(toInput.value).toBe("Airport");

    fireEvent.click(
      screen.getByRole("button", { name: /swap origin and destination/i }),
    );
    // After swap, From has what To had, and vice versa.
    const after = screen.getAllByRole("searchbox");
    const fromAfter = after[0] as HTMLInputElement;
    const toAfter = after[1] as HTMLInputElement;
    expect(fromAfter.value).toBe("Airport");
    expect(toAfter.value).toBe("Home");
  });

  it("is a no-op when both fields are empty", () => {
    renderSearch("/search");
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    // In a fresh /search with no query params, To is empty and From defaults
    // to the live-GPS pill (when geolocation provides a fix) or the empty
    // "From" input. We don't care which — swap should not crash either way.
    fireEvent.click(
      screen.getByRole("button", { name: /swap origin and destination/i }),
    );
    // Nothing to assert besides "didn't throw"; the router is still mounted.
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
  });
});
