import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import type { ResolvedSave } from "../../src/components/Search/PinnedSavesSection.tsx";

// Capture-on-commit hook: selecting a suggestion / save / typed coord must call recordRecent with
// the right `usedAsOrigin`, EXCEPT for live-GPS and URL-prefill which are excluded by construction.
vi.mock("../../src/services/recents.ts", async (o) => ({
  ...(await o<typeof import("../../src/services/recents.ts")>()),
  recordRecent: vi.fn().mockResolvedValue(undefined),
}));
import { recordRecent } from "../../src/services/recents.ts";

// Force server-side so Search.tsx uses the simple one-shot suggestions wrapper
// (deterministic single emit — no streaming/driver/IDB).
vi.mock("../../src/services/poiFetchMode.ts", () => ({
  resolvePoiFetchMode: vi.fn(() => "server-side"),
}));

// Stub the suggestion provider to emit one known POI suggestion.
vi.mock("../../src/services/searchSuggestions.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/searchSuggestions.ts")>();
  return {
    ...actual,
    searchSuggestions: vi.fn(async () => [
      {
        kind: "geocoded",
        label: "Central Library",
        lat: 54.7,
        lon: 25.3,
        confidence: 0.9,
        category: "landmark",
        source: "osm",
        poiIdentity: "node/42",
        score: 1,
      },
    ]),
    searchSuggestionsStream: vi.fn(async () => {}),
  };
});

// Geolocation is opt-in per test: default to no fix (so the From field is a text
// input, not the live-GPS pill); the live-GPS test overrides this.
const geoState = { location: null as { lat: number; lon: number } | null };
vi.mock("../../src/hooks/useGeolocation.ts", () => ({
  useGeolocation: () => ({
    location: geoState.location,
    error: null,
    loading: false,
    requestLocation: vi.fn(),
  }),
}));

// Stub PinnedSavesSection so the save-pair test can inject a ResolvedSave
// directly without needing live Dexie / crypto / dexie-react-hooks wiring.
// The stub renders a single "Pair save" button whose click fires onSelect.
let pinnedSavesOnSelect: ((save: ResolvedSave) => void) | null = null;
vi.mock("../../src/components/Search/PinnedSavesSection.tsx", () => ({
  PinnedSavesSection: ({ onSelect }: { onSelect: (save: ResolvedSave) => void }) => {
    pinnedSavesOnSelect = onSelect;
    return null;
  },
}));

import { SearchPage } from "../../src/pages/Search.tsx";
import { searchSuggestions, searchSuggestionsStream } from "../../src/services/searchSuggestions.ts";

const recordRecentMock = vi.mocked(recordRecent);
const searchSuggestionsStreamMock = vi.mocked(searchSuggestionsStream);

async function selectFirstSuggestion(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  // Debounce is 300ms; advance real time past it so the one-shot fires.
  await new Promise((r) => setTimeout(r, 350));
}

describe("Search.tsx records committed endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geoState.location = null;
  });

  it("keeps group counts beside Georgian romanization", async () => {
    vi.mocked(searchSuggestions).mockResolvedValueOnce([{
      kind: "stopGroup", groupId: "varketili", name: "ვარკეთილი", lat: 41.69, lon: 44.8,
      score: 1, stopCount: 2, stopIds: ["a", "b"],
    }]);
    const { getAllByRole, findByText } = render(
      <MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>,
    );
    await selectFirstSuggestion(getAllByRole("searchbox")[1] as HTMLInputElement, "vark");
    expect(await findByText("vark’etili · 2 stops")).toBeInTheDocument();
  });

  it("renders subtext and commits the native destination label", async () => {
    vi.mocked(searchSuggestions).mockResolvedValueOnce([{
      kind: "geocoded", label: "გალერია თბილისი", aliases: { en: ["Galleria Tbilisi"] },
      address: { street: "Rustaveli Ave", houseNumber: "2/4" },
      lat: 41.69, lon: 44.8, confidence: 1, category: "retail", source: "osm", poiIdentity: "mall", score: 1,
    }]);
    const { getAllByRole, findByRole, getByText } = render(
      <MemoryRouter initialEntries={["/search"]}><SearchPage /></MemoryRouter>,
    );
    await selectFirstSuggestion(getAllByRole("searchbox")[1] as HTMLInputElement, "galleria");
    const option = await findByRole("option", { name: /გალერია თბილისი/ });
    expect(getByText("Galleria Tbilisi · Rustaveli Ave 2/4")).toHaveClass("truncate");
    fireEvent.click(option);
    await waitFor(() => expect(recordRecentMock).toHaveBeenCalledWith(
      expect.objectContaining({ label: "გალერია თბილისი" }), { usedAsOrigin: false },
    ));
  });

  it('selecting a destination ("to") suggestion records it with usedAsOrigin: false', async () => {
    const { getAllByRole, findByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    // To is the second searchbox; focus + type to surface the suggestion list.
    const toInput = getAllByRole("searchbox")[1] as HTMLInputElement;
    await selectFirstSuggestion(toInput, "library");

    const option = await findByRole("option", { name: /Central Library/i });
    fireEvent.click(option);

    await waitFor(() => expect(recordRecentMock).toHaveBeenCalledTimes(1));
    expect(recordRecentMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "geocoded", label: "Central Library" }),
      { usedAsOrigin: false },
    );
  });

  it('selecting an origin ("from") suggestion records it with usedAsOrigin: true', async () => {
    const { getAllByRole, findByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    // From is the first searchbox (text input — no live GPS fix in this test).
    const fromInput = getAllByRole("searchbox")[0] as HTMLInputElement;
    await selectFirstSuggestion(fromInput, "library");

    const option = await findByRole("option", { name: /Central Library/i });
    fireEvent.click(option);

    await waitFor(() => expect(recordRecentMock).toHaveBeenCalledTimes(1));
    expect(recordRecentMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "geocoded", label: "Central Library" }),
      { usedAsOrigin: true },
    );
  });

  it("the live-GPS 'My location' path does NOT record a recent", async () => {
    // A geolocation fix seeds the From field with a live-GPS mappoint endpoint
    // via the userLocation effect — this commit must NOT be captured.
    geoState.location = { lat: 54.6872, lon: 25.2797 };
    const { findByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    // The live-GPS pill renders once the fix lands.
    await findByRole("button", { name: /My location.*Change/i });
    // Give any effects a chance to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(recordRecentMock).not.toHaveBeenCalled();
  });

  // D2 guard: URL-prefill (toLat/toLon/toName or toStopId) resolves an endpoint
  // via the useState initializer or a useEffect DB lookup — neither path goes
  // through captureRecent, so recordRecent must never fire.
  it("URL-prefill ?toLat/toLon/toName does NOT call recordRecent", async () => {
    render(
      <MemoryRouter initialEntries={["/search?toLat=54.7&toLon=25.2&toName=Library"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    // Give all mount effects time to settle (including any async prefill effects).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(recordRecentMock).not.toHaveBeenCalled();
  });

  // Pair save: selectSave calls captureRecent for BOTH the origin (usedAsOrigin:true)
  // and the destination (usedAsOrigin:false) when the save has a destination field.
  it("selecting a saved origin→destination pair records BOTH endpoints", async () => {
    pinnedSavesOnSelect = null;
    // PinnedSavesSection is rendered when activeField is set (i.e. a field is focused).
    // Focus the To input so activeField="to", which causes the PinnedSavesSection stub
    // to mount and capture its onSelect callback.
    const { getAllByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const toInput = getAllByRole("searchbox")[1] as HTMLInputElement;
    fireEvent.focus(toInput);

    // Wait for the stub's onSelect to be captured.
    await waitFor(() => expect(pinnedSavesOnSelect).not.toBeNull());

    const pairSave: ResolvedSave = {
      id: "save-1",
      alias: "Home → Work",
      savedAt: Date.now(),
      origin: { kind: "stop", stopId: "s1", name: "Home Stop", lat: 54.69, lon: 25.27 },
      destination: { kind: "stop", stopId: "s2", name: "Work Stop", lat: 54.71, lon: 25.30 },
    };

    act(() => {
      pinnedSavesOnSelect!(pairSave);
    });

    await waitFor(() => expect(recordRecentMock).toHaveBeenCalledTimes(2));
    expect(recordRecentMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stop", stopId: "s1" }),
      { usedAsOrigin: true },
    );
    expect(recordRecentMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stop", stopId: "s2" }),
      { usedAsOrigin: false },
    );
  });

  // Typed coordinate: entering "54.7, 25.2" in the To field resolves immediately
  // to a mappoint endpoint via parseCoordinateEndpoint and calls captureRecent.
  it('typing a "lat, lon" coordinate into To calls recordRecent with usedAsOrigin: false', async () => {
    const { getAllByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const toInput = getAllByRole("searchbox")[1] as HTMLInputElement;
    fireEvent.focus(toInput);
    fireEvent.change(toInput, { target: { value: "54.7, 25.2" } });

    await waitFor(() => expect(recordRecentMock).toHaveBeenCalledTimes(1));
    expect(recordRecentMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mappoint", lat: 54.7, lon: 25.2 }),
      { usedAsOrigin: false },
    );
  });
});

describe("Search.tsx shows recents on empty focus + badges them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geoState.location = null;
    // Default: the empty-query stream emits one recent-marked suggestion. The empty-focus effect
    // calls searchSuggestionsStream("",...) which returns the Recent group; here we emit it
    // directly via onResults.
    searchSuggestionsStreamMock.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (_q: string, _city: string, _loc: unknown, _sig: unknown, _provider: unknown, cb: any) => {
        cb?.onResults?.(
          [
            {
              kind: "stop",
              stopId: "R1",
              name: "Recent Stop",
              lat: 54.7,
              lon: 25.2,
              score: 0.5,
              recent: { usedAt: 1, usedAsOrigin: false },
            },
          ],
          { done: true, emitSeq: 0 },
        );
        return undefined;
      }) as unknown as typeof searchSuggestionsStream,
    );
  });

  it("focusing an EMPTY 'To' field populates the suggestion list with recents", async () => {
    const { getAllByRole, findByRole } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const toInput = getAllByRole("searchbox")[1] as HTMLInputElement;
    fireEvent.focus(toInput);

    // The empty-focus effect fires searchSuggestionsStream("", ...) and renders
    // the recent row WITHOUT any typing.
    const option = await findByRole("option", { name: /Recent Stop/i });
    expect(option).toBeInTheDocument();
    // The empty-focus effect fetches the Recent group with an empty query and an
    // onResults callback (the rest of the args are environment-dependent).
    const emptyQueryCall = searchSuggestionsStreamMock.mock.calls.find((c) => c[0] === "");
    expect(emptyQueryCall).toBeDefined();
    expect(emptyQueryCall![5]).toEqual(
      expect.objectContaining({ onResults: expect.any(Function) }),
    );
  });

  it("a suggestion row whose `recent` marker is set renders a 'Recent' badge", async () => {
    const { getAllByRole, findByTestId } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    const toInput = getAllByRole("searchbox")[1] as HTMLInputElement;
    fireEvent.focus(toInput);

    const badge = await findByTestId("recent-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/recent/i);
  });

  it("separates the Recent badge from the row subtitle instead of gluing them", async () => {
    // A recent POI row carries BOTH the badge and a "POI" subtitle. They used
    // to be adjacent inline spans with nothing between them, so the row read
    // "RECENTPOI" — worse in a locale whose word for "recent" is long.
    searchSuggestionsStreamMock.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (_q: string, _city: string, _loc: unknown, _sig: unknown, _provider: unknown, cb: any) => {
        cb?.onResults?.(
          [
            {
              kind: "geocoded",
              label: "Eisiskiu plentas",
              lat: 54.7,
              lon: 25.2,
              confidence: 0.9,
              category: "landmark",
              source: "osm",
              poiIdentity: "node/7",
              score: 1,
              recent: { usedAt: 1, usedAsOrigin: false },
            },
          ],
          { done: true, emitSeq: 0 },
        );
        return undefined;
      }) as unknown as typeof searchSuggestionsStream,
    );

    const { getAllByRole, findByTestId } = render(
      <MemoryRouter initialEntries={["/search"]}>
        <SearchPage />
      </MemoryRouter>,
    );
    fireEvent.focus(getAllByRole("searchbox")[1] as HTMLInputElement);

    const badge = await findByTestId("recent-badge");
    const meta = badge.parentElement as HTMLElement;
    // Badge and subtitle are siblings in one flex row, so they are laid out
    // with a gap rather than butted together in a single text run.
    expect(meta.className).toMatch(/\bgap-/);
    expect(meta.children).toHaveLength(2);
    expect(meta.children[1].textContent).toBe("POI");
    expect(meta.className).toMatch(/\bflex\b/);
    // The badge must not be the subtitle's immediate text neighbour: that is
    // the arrangement that rendered them as one word.
    expect(badge.nextSibling).not.toBeNull();
    expect(badge.nextSibling?.nodeType).toBe(Node.ELEMENT_NODE);
  });
});
