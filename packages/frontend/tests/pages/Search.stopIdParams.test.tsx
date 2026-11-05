import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";

function renderSearch(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/search${search}`]}>
      <SearchPage />
    </MemoryRouter>,
  );
}

describe("Search fromStopId/toStopId query-param prefill", () => {
  beforeEach(async () => {
    useRoutingStore.setState({ ranking: "fastest", results: [], error: null, loading: false });
    await db.gtfsStops.clear();
    await db.gtfsStops.bulkPut([
      { id: "stop-a", name: "Alpha Station", lat: 50.1, lon: 19.9 },
      { id: "stop-b", name: "Beta Plaza", lat: 50.2, lon: 20.0 },
    ]);
  });

  it("resolves fromStopId and toStopId and populates the input fields", async () => {
    renderSearch("?fromStopId=stop-a&toStopId=stop-b");

    await waitFor(() => {
      const fields = screen.getAllByRole("searchbox") as HTMLInputElement[];
      const values = fields.map((f) => f.value);
      expect(values).toContain("Alpha Station");
      expect(values).toContain("Beta Plaza");
    });
  });

  it("ignores unknown stop IDs without throwing", async () => {
    renderSearch("?fromStopId=nope&toStopId=stop-b");

    await waitFor(() => {
      const fields = screen.getAllByRole("searchbox") as HTMLInputElement[];
      const values = fields.map((f) => f.value);
      expect(values).toContain("Beta Plaza");
    });
    // Unknown fromStopId leaves the from field empty (no throw).
    const fields = screen.getAllByRole("searchbox") as HTMLInputElement[];
    const values = fields.map((f) => f.value);
    expect(values).not.toContain("Alpha Station");
  });

  it("prefers toStopId over toLat/toLon/toName params", async () => {
    renderSearch("?toStopId=stop-a&toLat=0&toLon=0&toName=Ignored");

    await waitFor(() => {
      const fields = screen.getAllByRole("searchbox") as HTMLInputElement[];
      const values = fields.map((f) => f.value);
      expect(values).toContain("Alpha Station");
      expect(values).not.toContain("Ignored");
    });
  });
});
