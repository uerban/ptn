import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/services/poiFetchMode.ts", () => ({
  resolvePoiFetchMode: vi.fn(() => "eager-bundle"),
}));
// 40 matches for a city-name query; the list must not stop at the first page.
vi.mock("../../src/services/searchSuggestions.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/searchSuggestions.ts")>();
  return {
    ...actual,
    searchSuggestionsStream: vi.fn(async (q: string, _c, _h, _s, _p, cb) => {
      if (!q) return;
      cb.onResults(
        Array.from({ length: 40 }, (_, i) => ({
          kind: "geocoded", label: `Place ${i + 1}`, lat: 0, lon: i, confidence: 1 - i / 100,
          category: "tourism", source: "osm", poiIdentity: `node/${i}`, score: 1 - i / 100,
        })),
        { done: true, emitSeq: 0 },
      );
    }),
    searchSuggestions: vi.fn(async () => []),
  };
});
vi.mock("../../src/services/poiManifest.ts", () => ({ getCityPoiTiling: vi.fn(async () => null) }));
vi.mock("../../src/services/poiSync.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/poiSync.ts")>()),
  getActiveTileLoader: vi.fn(() => undefined),
}));

import { SearchPage } from "../../src/pages/Search.tsx";
import { SUGGESTION_PAGE_SIZE } from "../../src/services/searchSuggestions.ts";

async function typeQuery(value: string) {
  const input = screen.getAllByRole("searchbox")[0] as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  await vi.advanceTimersByTimeAsync(350);
  vi.useRealTimers();
  await screen.findByText("Place 1");
}

describe("Search results 'Show more'", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });

  it("shows one page, then the next page on each tap, then hides the button", async () => {
    render(<MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>);
    await typeQuery("tbilisi");

    expect(screen.getAllByRole("option")).toHaveLength(SUGGESTION_PAGE_SIZE);
    expect(screen.queryByText(`Place ${SUGGESTION_PAGE_SIZE + 1}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("search-show-more"));
    expect(screen.getAllByRole("option")).toHaveLength(SUGGESTION_PAGE_SIZE * 2);

    fireEvent.click(screen.getByTestId("search-show-more"));
    expect(screen.getAllByRole("option")).toHaveLength(40);
    expect(screen.queryByTestId("search-show-more")).not.toBeInTheDocument();
  });

  it("starts from one page again after the query changes", async () => {
    render(<MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>);
    await typeQuery("tbilisi");
    fireEvent.click(screen.getByTestId("search-show-more"));
    expect(screen.getAllByRole("option")).toHaveLength(SUGGESTION_PAGE_SIZE * 2);

    vi.useFakeTimers();
    await typeQuery("galleria");
    expect(screen.getAllByRole("option")).toHaveLength(SUGGESTION_PAGE_SIZE);
  });
});
