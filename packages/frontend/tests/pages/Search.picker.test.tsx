import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "../../src/pages/Search.tsx";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { SearchLayoutSettings } from "../../src/components/Search/SearchLayoutSettings.tsx";
import { searchSuggestionsStream } from "../../src/services/searchSuggestions.ts";

vi.mock("../../src/hooks/useGeolocation.ts", () => ({ useGeolocation: () => ({ location: null, loading: false }) }));
vi.mock("../../src/services/poiFetchMode.ts", () => ({ resolvePoiFetchMode: () => "eager-bundle" }));
vi.mock("../../src/services/searchSuggestions.ts", () => ({ SUGGESTION_PAGE_SIZE: 15, searchSuggestions: vi.fn(), searchSuggestionsStream: vi.fn() }));
const stream = vi.mocked(searchSuggestionsStream);
const mount = () => render(<MemoryRouter><SearchPage /></MemoryRouter>);
const toInput = () => screen.getByRole("searchbox", { name: "Where to?" });

beforeEach(() => {
  stream.mockReset();
  stream.mockImplementation(async (_q, _c, _h, _s, _p, cb) => { cb.onResults([], { done: true, emitSeq: 0 }); });
  useSettingsStore.setState({ searchActiveFieldOnly: true, searchKeyboardFit: true, searchCompactRows: true, searchDismissOnScroll: true });
});

describe("search place picker", () => {
  it("shows loading before debounce and empty feedback after completion", async () => {
    mount();
    fireEvent.change(toInput(), { target: { value: "zzzz" } });
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    expect(screen.queryByText("Remember recent places?")).not.toBeInTheDocument();
    await screen.findByText("No matching place suggestions");
    expect(screen.queryByRole("tablist", { name: "Sort" })).not.toBeInTheDocument();
  });
  it("shows failed searches separately from empty results", async () => {
    stream.mockRejectedValue(new Error("unavailable"));
    mount();
    fireEvent.change(toInput(), { target: { value: "library" } });
    await screen.findByText("Could not search for places. Try again.");
    expect(screen.queryByText("No matching place suggestions")).not.toBeInTheDocument();
  });
  it("ignores stale results on field switch and restores the form on Back", async () => {
    let oldEmit: Parameters<typeof searchSuggestionsStream>[5]["onResults"] | undefined;
    let signal: AbortSignal | undefined;
    stream.mockImplementation(async (query, _c, _h, abort, _p, cb) => { if (query === "old") { oldEmit = cb.onResults; signal = abort; } });
    const view = mount();
    fireEvent.change(toInput(), { target: { value: "old" } });
    await waitFor(() => expect(oldEmit).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Edit origin/ }));
    expect(screen.getByRole("searchbox", { name: "From" })).toHaveFocus();
    expect(signal?.aborted).toBe(true);
    act(() => oldEmit?.([{ kind: "stop", stopId: "stale", name: "Stale", lat: 1, lon: 1, score: 1 }], { done: true, emitSeq: 1 }));
    expect(screen.queryByRole("option", { name: /Stale/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tablist", { name: "Sort" })).toBeInTheDocument();
    expect(view.container.querySelector("[data-active-field]")).toBeNull();
    expect(toInput()).toHaveValue("old");
  });
  it("Enter selects the first result, preserving IME composition", async () => {
    stream.mockImplementation(async (query, _c, _h, _s, _p, cb) => { cb.onResults(query ? [{ kind: "stop", stopId: "library", name: "Library", lat: 54, lon: 25, score: 1 }] : [], { done: true, emitSeq: 0 }); });
    const view = mount();
    fireEvent.change(toInput(), { target: { value: "lib" } });
    await screen.findByRole("option", { name: /Library/ });
    fireEvent.keyDown(toInput(), { key: "Enter", isComposing: true });
    expect(screen.getByRole("option", { name: /Library/ })).toBeInTheDocument();
    fireEvent.keyDown(toInput(), { key: "Enter" });
    expect(toInput()).toHaveValue("Library");
    expect(view.container.querySelector("[data-active-field]")).toBeNull();
  });
  it("respects the keyboard-on-scroll preference without closing the picker", () => {
    const view = mount();
    (toInput() as HTMLInputElement).focus();
    const scrollArea = view.container.querySelector(".overflow-y-auto")!;
    fireEvent.wheel(scrollArea);
    expect(toInput()).not.toHaveFocus();
    expect(view.container.querySelector("[data-active-field]")).not.toBeNull();
    act(() => useSettingsStore.setState({ searchDismissOnScroll: false }));
    (toInput() as HTMLInputElement).focus();
    fireEvent.wheel(scrollArea);
    expect(toInput()).toHaveFocus();
  });
  it("exposes exactly four temporary settings which change the stored choices", () => {
    render(<SearchLayoutSettings />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    for (const box of screen.getAllByRole("checkbox")) { expect(box).toBeChecked(); fireEvent.click(box); }
    const state = useSettingsStore.getState();
    expect([state.searchActiveFieldOnly, state.searchKeyboardFit, state.searchCompactRows, state.searchDismissOnScroll]).toEqual([false, false, false, false]);
  });
});
