import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Itinerary } from "@pt/shared";

vi.mock("./ScheduleHome.tsx", () => ({
  ScheduleHome: ({ onShowMap }: { onShowMap: () => void }) => (
    <main aria-label="Text mode">
      <button type="button" data-return-focus="show-map" onClick={onShowMap}>Show map</button>
    </main>
  ),
}));
vi.mock("../components/Guidance/TextGuidance.tsx", () => ({
  TextGuidance: ({ onShowMap }: { onShowMap: () => void }) => (
    <section data-testid="text-guidance">
      <button type="button" onClick={onShowMap}>Show trip map</button>
    </section>
  ),
}));
vi.mock("../hooks/useWatchPosition.ts", () => ({ useWatchPosition: () => ({ position: null }) }));

import { TextHome } from "./TextHome.tsx";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useLineViewStore } from "../stores/lineViewStore.ts";
import type { TemporaryMap } from "../presentation/temporaryMap.ts";

const temporaryMap: TemporaryMap = { active: false, open: vi.fn(), close: vi.fn() };

function Url() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<TextHome temporaryMap={temporaryMap} />} />
        <Route path="*" element={null} />
      </Routes>
      <Url />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useGuidanceStore.getState().stopNavigation();
  useLineViewStore.getState().hideLine();
  // No Cache Storage: the map files count as not downloaded yet.
  vi.stubGlobal("caches", undefined);
});

describe("TextHome", () => {
  it("shows the text home screen while no trip is on", () => {
    renderHome();
    expect(screen.getByRole("main", { name: "Text mode" })).toBeTruthy();
    expect(screen.queryByTestId("text-guidance")).toBeNull();
  });

  it("shows text guidance once a trip starts", () => {
    renderHome();
    act(() => {
      useGuidanceStore.getState().startNavigation({ legs: [] } as unknown as Itinerary);
    });
    expect(screen.getByTestId("text-guidance")).toBeTruthy();
    expect(screen.queryByRole("main", { name: "Text mode" })).toBeNull();
  });

  it("discloses the map download before Show map opens anything", async () => {
    renderHome();
    fireEvent.click(screen.getByText("Show map"));
    await screen.findByTestId("map-download-disclosure");
    expect(temporaryMap.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download and show map" }));
    expect(temporaryMap.open).toHaveBeenCalledWith("show-map");
  });

  it("opens a line on its own page instead of the map's line overlay", () => {
    renderHome();
    act(() => {
      useLineViewStore.getState().showLine("r 1", "1", "#f00", [], 1);
    });
    expect(screen.getByTestId("url").textContent).toBe("/line/r%201?dir=1");
    expect(useLineViewStore.getState().isVisible).toBe(false);
  });
});
