import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// Force lazy-tile so Search.tsx takes the stream branch.
vi.mock("../../src/services/poiFetchMode.ts", () => ({
  resolvePoiFetchMode: vi.fn(() => "lazy-tile"),
}));
// Spy on the REAL stream; emit twice via the cb Search.tsx passes.
vi.mock("../../src/services/searchSuggestions.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/searchSuggestions.ts")>();
  return {
    ...actual,
    searchSuggestionsStream: vi.fn(async (_q, _c, _h, _s, _p, cb) => {
      cb.onResults(
        [{ kind: "geocoded", label: "First", lat: 0, lon: 0, confidence: 1, category: "x", source: "osm", poiIdentity: "node/1", score: 1 }],
        { done: false, emitSeq: 0 },
      );
      cb.onResults(
        [
          { kind: "geocoded", label: "First", lat: 0, lon: 0, confidence: 1, category: "x", source: "osm", poiIdentity: "node/1", score: 1 },
          { kind: "geocoded", label: "Second", lat: 0, lon: 0, confidence: 0.5, category: "x", source: "osm", poiIdentity: "node/2", score: 0.5 },
        ],
        { done: true, emitSeq: 1 },
      );
    }),
    // Keep the one-shot wrapper a no-op so the eager branch (if hit) is inert.
    searchSuggestions: vi.fn(async () => []),
  };
});

// Mock the wiring deps Search.tsx imports so the driver build does not touch IDB.
vi.mock("../../src/services/poiManifest.ts", () => ({ getCityPoiTiling: vi.fn(async () => null) }));
vi.mock("../../src/services/poiSync.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/poiSync.ts")>()),
  getActiveTileLoader: vi.fn(() => undefined),
}));

import { SearchPage } from "../../src/pages/Search.tsx";
import * as ss from "../../src/services/searchSuggestions.ts";
import * as pfm from "../../src/services/poiFetchMode.ts";

describe("Search.tsx consumes the stream in lazy-tile mode (AC-15)", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });

  it("typing fires the REAL stream branch; both emits re-render the suggestions list", async () => {
    // Render the real component. Inputs render as role=searchbox; the first is
    // the From field. Suggestions only render once a field is focused (activeField).
    const { getAllByRole, findByText } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const input = getAllByRole("searchbox")[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "alpha" } });
    // Advance the 300ms debounce timer so handleSearch issues the stream call.
    await vi.advanceTimersByTimeAsync(350);

    // Typing the query routes through the stream branch exactly once (the
    // empty-focus effect also fires the stream with an empty query for the
    // Recent group — filter those out so this asserts the TYPED path only).
    const typedCalls = vi
      .mocked(ss.searchSuggestionsStream)
      .mock.calls.filter((c) => c[0] === "alpha");
    expect(typedCalls).toHaveLength(1);
    // The eager one-shot path must NOT be used in lazy-tile mode.
    expect(vi.mocked(ss.searchSuggestions)).not.toHaveBeenCalled();
    // Both emits reached the DOM (the second emit's "Second" row is the proof
    // the re-render fired on the NON-final and final emit, not just once).
    vi.useRealTimers();
    expect(await findByText("First")).toBeInTheDocument();
    expect(await findByText("Second")).toBeInTheDocument();
  });
});

describe("Search.tsx routes eager-bundle through the stream too (progressive augmentation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Override the module-level lazy-tile mock so this describe exercises eager.
    vi.mocked(pfm.resolvePoiFetchMode).mockReturnValue("eager-bundle");
  });

  it("eager-bundle takes the STREAM branch (no driver), NOT the blocking one-shot wrapper — so the gated augment second emit renders progressively", async () => {
    const { getAllByRole, findByText } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const input = getAllByRole("searchbox")[0] as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "alpha" } });
    await vi.advanceTimersByTimeAsync(350);

    // Eager now streams (so a sparse-local augment second emit reaches the UI instead
    // of the wrapper discarding the instant first emit and blocking on augment). The
    // blocking one-shot wrapper is reserved for single-emit server-side (AC-10).
    // Filter to the TYPED call — the empty-focus effect also streams the empty
    // query for the Recent group, which must not count toward the eager path.
    const typedCalls = vi
      .mocked(ss.searchSuggestionsStream)
      .mock.calls.filter((c) => c[0] === "alpha");
    expect(typedCalls).toHaveLength(1);
    expect(vi.mocked(ss.searchSuggestions)).not.toHaveBeenCalled();
    // Eager streams WITHOUT a prefetch driver (the driver is lazy-tile-only).
    const cbArg = typedCalls[0]![5] as { driver?: unknown };
    expect(cbArg.driver).toBeUndefined();
    vi.useRealTimers();
    // Both emits rendered → progressive (not collapsed to one frame by the wrapper).
    expect(await findByText("First")).toBeInTheDocument();
    expect(await findByText("Second")).toBeInTheDocument();
  });
});
