import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Stop } from "@pt/shared";
import type { TemporaryMap } from "../presentation/temporaryMap.ts";

const CENTRAL: Stop = { id: "S1", name: "Central", location: { lat: 54.35, lon: 18.65 } };

vi.mock("./Home.tsx", () => ({
  HomePage: ({ onBackToText, contextStop }: { onBackToText?: () => void; contextStop?: Stop | null }) => (
    <section data-testid="map">
      <span data-testid="map-stop">{contextStop?.name ?? "none"}</span>
      <button type="button" onClick={onBackToText}>Back to text</button>
    </section>
  ),
}));
vi.mock("./TextHome.tsx", () => ({
  TextHome: ({
    temporaryMap,
    selectedStop,
    onSelectStop,
  }: {
    temporaryMap: TemporaryMap;
    selectedStop?: Stop | null;
    onSelectStop?: (stop: Stop | null) => void;
  }) => (
    <section data-testid="text">
      <span data-testid="text-stop">{selectedStop?.name ?? "none"}</span>
      <button type="button" onClick={() => onSelectStop?.(CENTRAL)}>Open Central</button>
      <button type="button" onClick={() => temporaryMap.open()}>Show map</button>
    </section>
  ),
}));
vi.mock("../components/Guidance/GuidanceSession.tsx", () => ({
  GuidanceSessionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { HomeDispatcher } from "./HomeDispatcher.tsx";
import { useSettingsStore } from "../stores/settingsStore.ts";

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<HomeDispatcher />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useSettingsStore.getState().setScheduleMode(true);
});

describe("HomeDispatcher", () => {
  it("keeps the text screen's stop across a temporary map and gives it to the map", async () => {
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "Open Central" }));
    expect(screen.getByTestId("text-stop").textContent).toBe("Central");

    fireEvent.click(screen.getByRole("button", { name: "Show map" }));
    expect((await screen.findByTestId("map-stop")).textContent).toBe("Central");

    fireEvent.click(screen.getByRole("button", { name: "Back to text" }));
    expect((await screen.findByTestId("text-stop")).textContent).toBe("Central");
  });

  it("gives the saved map view no text-screen stop", async () => {
    useSettingsStore.getState().setScheduleMode(false);
    renderHome();
    expect((await screen.findByTestId("map-stop")).textContent).toBe("none");
  });
});
