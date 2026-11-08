import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { restoreReturnFocus, useTemporaryMap } from "./temporaryMap.ts";
import { useShowMapAction } from "./ShowMapAction.tsx";
import { MAP_ASSETS_CACHE, mapAssetsCached } from "./mapAssetsCache.ts";

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  const temporaryMap = useTemporaryMap();
  return (
    <div>
      <span data-testid="url">{`${location.pathname}${location.search}`}</span>
      <span data-testid="active">{String(temporaryMap.active)}</span>
      <button type="button" data-return-focus="opener" onClick={() => temporaryMap.open("opener")}>
        open
      </button>
      <button type="button" onClick={temporaryMap.close}>close</button>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

function renderAt(entries: string[], index?: number) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("useTemporaryMap", () => {
  it("opens as a history entry on the current route and Back to text pops it", () => {
    renderAt(["/?from=a"]);
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("url").textContent).toBe("/?from=a&view=map");
    expect(screen.getByTestId("active").textContent).toBe("true");
    fireEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("url").textContent).toBe("/?from=a");
    expect(screen.getByTestId("active").textContent).toBe("false");
  });

  it("browser Back returns from the map like Back to text", () => {
    renderAt(["/"]);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("url").textContent).toBe("/");
  });

  it("drops the parameter in place when the map was not opened here (link or reload)", () => {
    renderAt(["/settings", "/?view=map"], 1);
    expect(screen.getByTestId("active").textContent).toBe("true");
    fireEvent.click(screen.getByText("close"));
    // Replaced, not popped: the previous entry is not where the user goes.
    expect(screen.getByTestId("url").textContent).toBe("/");
  });

  it("restores focus to the opener once, by its data-return-focus name", async () => {
    renderAt(["/"]);
    fireEvent.click(screen.getByText("open"));
    (document.activeElement as HTMLElement | null)?.blur();
    restoreReturnFocus();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("open")));
    (document.activeElement as HTMLElement).blur();
    restoreReturnFocus();
    expect(document.activeElement).toBe(document.body);
  });
});

function ShowMapHarness({ cached }: { cached: boolean }) {
  const temporaryMap = useTemporaryMap();
  const location = useLocation();
  const action = useShowMapAction(temporaryMap, async () => cached);
  return (
    <>
      <span data-testid="url">{`${location.pathname}${location.search}`}</span>
      <button type="button" data-return-focus="show-map" onClick={() => action.request("show-map")}>
        Show map
      </button>
      {action.disclosure}
    </>
  );
}

function renderShowMap(cached: boolean) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="*" element={<ShowMapHarness cached={cached} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("useShowMapAction", () => {
  it("opens the map at once when its files are already on this device", async () => {
    renderShowMap(true);
    fireEvent.click(screen.getByText("Show map"));
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("/?view=map"));
    expect(screen.queryByTestId("map-download-disclosure")).toBeNull();
  });

  it("discloses the one-time download first and opens only on confirmation", async () => {
    renderShowMap(false);
    fireEvent.click(screen.getByText("Show map"));
    const dialog = await screen.findByRole("dialog", { name: "Show a map?" });
    expect(dialog.textContent).toMatch(/downloaded once/);
    expect(dialog.textContent).toMatch(/starting view stays Text mode/);
    expect(screen.getByTestId("url").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Download and show map" }));
    expect(screen.getByTestId("url").textContent).toBe("/?view=map");
  });

  it("Cancel keeps the text screen and returns focus to Show map", async () => {
    renderShowMap(false);
    fireEvent.click(screen.getByText("Show map"));
    await screen.findByTestId("map-download-disclosure");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("map-download-disclosure")).toBeNull();
    expect(screen.getByTestId("url").textContent).toBe("/");
    expect(document.activeElement).toBe(screen.getByText("Show map"));
  });
});

describe("mapAssetsCached", () => {
  function storage(urls: string[] | null): CacheStorage {
    return {
      has: vi.fn(async (name: string) => name === MAP_ASSETS_CACHE && urls !== null),
      open: vi.fn(async () => ({
        keys: async () => (urls ?? []).map((url) => new Request(url)),
      })),
    } as unknown as CacheStorage;
  }

  beforeEach(() => vi.clearAllMocks());

  it("is false without the cache, and never creates it", async () => {
    const caches = storage(null);
    expect(await mapAssetsCached(caches)).toBe(false);
    expect(caches.open).not.toHaveBeenCalled();
  });

  it("is true only once the MapLibre chunk is cached", async () => {
    expect(await mapAssetsCached(storage(["http://x/glyphs/font/0-255.pbf"]))).toBe(false);
    expect(await mapAssetsCached(storage(["http://x/assets/vendor-map-Ab12_c.js"]))).toBe(true);
  });

  it("is false where Cache Storage is missing or fails", async () => {
    expect(await mapAssetsCached(undefined)).toBe(false);
    const broken = { has: async () => { throw new Error("SecurityError"); } } as unknown as CacheStorage;
    expect(await mapAssetsCached(broken)).toBe(false);
  });
});
