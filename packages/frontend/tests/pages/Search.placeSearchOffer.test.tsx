import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/services/poiFetchMode.ts", () => ({
  resolvePoiFetchMode: vi.fn(() => "eager-bundle"),
}));
vi.mock("../../src/services/searchSuggestions.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/searchSuggestions.ts")>();
  return {
    ...actual,
    searchSuggestionsStream: vi.fn(async (_q, _c, _h, _s, _p, cb) => {
      cb.onResults([], { done: true, emitSeq: 0 });
    }),
    searchSuggestions: vi.fn(async () => []),
  };
});
vi.mock("../../src/services/geocoder/registerSelfHosted.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/geocoder/registerSelfHosted.ts")>()),
  hasServerSideGeocoder: vi.fn(() => true),
}));

import { SearchPage } from "../../src/pages/Search.tsx";
import * as ss from "../../src/services/searchSuggestions.ts";
import * as geocoder from "../../src/services/geocoder/registerSelfHosted.ts";
import { useNetworkDecisionsStore } from "../../src/stores/networkDecisionsStore.ts";
import { canUse } from "../../src/privacy/canUse.ts";
import { __resetContextualPromptsForTests } from "../../src/privacy/contextualPrompts.ts";

const OFFER = "Search addresses on the server";

function renderAndType(query: string) {
  const view = render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>,
  );
  const input = view.getAllByRole("searchbox")[0] as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: query } });
  return view;
}

function typedCalls(query: string) {
  return vi.mocked(ss.searchSuggestionsStream).mock.calls.filter((c) => c[0] === query);
}

describe("Search offers the operator's address search when it is not allowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(geocoder.hasServerSideGeocoder).mockReturnValue(true);
    useNetworkDecisionsStore.getState().reset();
    __resetContextualPromptsForTests();
  });
  afterEach(() => cleanup());

  it("asks before searching addresses on the server and grants only that flow", async () => {
    const view = renderAndType("Gedimino 9");
    await waitFor(() => expect(typedCalls("Gedimino 9")).toHaveLength(1));

    fireEvent.click(view.getByRole("button", { name: OFFER }));
    const disclosure = view.getByTestId("flow-disclosure");
    expect(disclosure.dataset.flow).toBe("operator.place-search");
    expect(canUse("operator.place-search")).toBe(false);

    fireEvent.click(within(disclosure).getByRole("button", { name: OFFER }));
    expect(canUse("operator.place-search")).toBe(true);
    const decisions = useNetworkDecisionsStore.getState().decisions;
    expect(Object.keys(decisions)).toEqual(["operator.place-search"]);
    expect(decisions["operator.place-search"]?.source).toBe("contextual");

    // The suggestions rerun with the address search allowed, and the offer goes.
    await waitFor(() => expect(typedCalls("Gedimino 9")).toHaveLength(2));
    expect(view.queryByRole("button", { name: OFFER })).toBeNull();
  });

  it("Not now leaves the flow unset", () => {
    const view = renderAndType("Gedimino 9");
    fireEvent.click(view.getByRole("button", { name: OFFER }));
    fireEvent.click(view.getByRole("button", { name: "Not now" }));
    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
    expect(view.getByRole("button", { name: OFFER })).toBeInTheDocument();
  });

  it("still offers Allow after the flow was denied", () => {
    useNetworkDecisionsStore
      .getState()
      .setDecision("operator.place-search", "denied", "settings");
    const view = renderAndType("Gedimino 9");
    fireEvent.click(view.getByRole("button", { name: OFFER }));
    expect(view.queryByRole("button", { name: "Don't ask again" })).toBeNull();
    fireEvent.click(within(view.getByTestId("flow-disclosure")).getByRole("button", { name: OFFER }));
    expect(canUse("operator.place-search")).toBe(true);
  });

  it("offers nothing without an address search server or a typed query", () => {
    vi.mocked(geocoder.hasServerSideGeocoder).mockReturnValue(false);
    const view = renderAndType("Gedimino 9");
    expect(view.queryByRole("button", { name: OFFER })).toBeNull();
    cleanup();
    vi.mocked(geocoder.hasServerSideGeocoder).mockReturnValue(true);
    const empty = renderAndType("");
    expect(empty.queryByRole("button", { name: OFFER })).toBeNull();
  });

  it("offers nothing while the flow is allowed", () => {
    useNetworkDecisionsStore
      .getState()
      .setDecision("operator.place-search", "allowed", "settings");
    const view = renderAndType("Gedimino 9");
    expect(view.queryByRole("button", { name: OFFER })).toBeNull();
  });
});
