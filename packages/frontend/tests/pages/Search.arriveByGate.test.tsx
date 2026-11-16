// The default build's gate draws no Arrive-by control on the Search page.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";
import { ArriveByResults, ArriveByToolbar } from "../../src/components/ArriveBy/arriveByEntry.ts";

describe("Search without the arrive-by experiment", () => {
  it("has a null gate and no arrive-by control", () => {
    expect(ArriveByToolbar).toBeNull();
    expect(ArriveByResults).toBeNull();
    render(
      <MemoryRouter initialEntries={["/search?toLat=54.7&toLon=25.3&toName=Somewhere"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("arrive-by-toolbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arrive by" })).not.toBeInTheDocument();
  });
});
