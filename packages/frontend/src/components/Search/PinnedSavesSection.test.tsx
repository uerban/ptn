import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import type { BaseEndpoint } from "@pt/shared";
import { PinnedSavesSection, type ResolvedSave } from "./PinnedSavesSection.tsx";
import { restoreSave, saveRoutePair, type SavePayload } from "../../services/saves.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";
import { findLeaks, rawTableText, resetPersonalStorage } from "../../test-helpers/personalStorage.ts";

type SeedSave = Omit<SavePayload, "alias" | "savedAt"> & { id: string; alias: string; savedAt: number };

async function seed(saves: SeedSave[]): Promise<void> {
  // Saves belong to the city where they were made; default to the active one.
  const cityId = useCityStore.getState().activeCity.id;
  for (const { id, ...payload } of saves) await restoreSave(id, { cityId, ...payload });
}

const stop1: BaseEndpoint = {
  kind: "stop",
  stopId: "S1",
  name: "Central",
  lat: 54.35,
  lon: 18.65,
};
const stop2: BaseEndpoint = {
  kind: "stop",
  stopId: "S2",
  name: "University",
  lat: 54.4,
  lon: 18.6,
};
const home: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.4,
  lon: 18.6,
  label: "Długa 21",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

afterEach(() => {
  cleanup();
});

beforeEach(async () => {
  await resetPersonalStorage();
  usePrivacyStore.getState().reset();
});

describe("PinnedSavesSection", () => {
  test("renders nothing when there are no saves", async () => {
    const { container } = render(
      <PinnedSavesSection onSelect={vi.fn()} />,
    );
    await waitFor(() => {
      expect(container.querySelector("[role=list]")).toBeNull();
    });
  });

  test("renders saves sorted by savedAt DESC", async () => {
    await seed([
      { id: "old", origin: stop1, alias: "Old", savedAt: 100 },
      { id: "new", origin: stop2, alias: "New", savedAt: 500 },
      { id: "mid", origin: home, alias: "Mid", savedAt: 300 },
    ]);
    render(<PinnedSavesSection onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("New");
    expect(items[1]!.textContent).toContain("Mid");
    expect(items[2]!.textContent).toContain("Old");
  });

  test("invokes onSelect with the resolved save when clicked", async () => {
    await seed([
      { id: "a", origin: stop1, alias: "Home", savedAt: 100 },
    ]);
    const onSelect = vi.fn();
    render(<PinnedSavesSection onSelect={onSelect} />);
    await waitFor(() => screen.getByRole("listitem"));
    fireEvent.click(screen.getByRole("listitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0]![0] as ResolvedSave;
    expect(arg.id).toBe("a");
    expect(arg.alias).toBe("Home");
    expect(arg.origin).toEqual(stop1);
    expect(arg.destination).toBeUndefined();
  });

  test("stores the save sealed and exposes both endpoints for pairs", async () => {
    await saveRoutePair(
      { origin: stop1, destination: home, alias: "Daily" },
      { now: () => 9_000, id: "pair-1" },
    );
    const raw = await rawTableText("savedLocations");
    expect(findLeaks(raw, ["Daily", "Długa", "Central"])).toEqual([]);

    const onSelect = vi.fn();
    render(<PinnedSavesSection onSelect={onSelect} />);
    await waitFor(() => screen.getByRole("listitem"));
    expect(screen.getByRole("listitem").textContent).toContain("Daily");
    fireEvent.click(screen.getByRole("listitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0]![0] as ResolvedSave;
    expect(arg.alias).toBe("Daily");
    expect(arg.origin).toEqual(stop1);
    expect(arg.destination).toEqual(home);
  });

  test("falls back to a derived label when alias is empty", async () => {
    await seed([
      { id: "x", origin: stop1, alias: "", savedAt: 100 },
    ]);
    render(<PinnedSavesSection onSelect={vi.fn()} />);
    await waitFor(() => screen.getByRole("listitem"));
    expect(screen.getByRole("listitem").textContent).toContain("Central");
  });

  test("renders pair label as origin → destination when alias empty", async () => {
    await seed([
      {
        id: "p",
        origin: stop1,
        destination: stop2,
        alias: "",
        savedAt: 100,
      },
    ]);
    render(<PinnedSavesSection onSelect={vi.fn()} />);
    await waitFor(() => screen.getByRole("listitem"));
    const text = screen.getByRole("listitem").textContent ?? "";
    expect(text).toContain("Central");
    expect(text).toContain("University");
  });
});

describe("searchable saved places and trips", () => {
  beforeEach(async () => {
    await seed([
    { id: "pair", origin: stop1, destination: home, alias: "Daily trip", savedAt: 100 },
    { id: "stop", origin: stop2, alias: "Classes", savedAt: 200 },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `home-${index}`, origin: home, alias: `Home ${index}`, savedAt: 300 + index })),
    ]);
  });

  test("bounds the empty-query preview and exposes the full collection", async () => {
    render(<PinnedSavesSection onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Show all saved items (7)" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  test("matches normalized destination names and keeps both saved-trip endpoints", async () => {
    const onSelect = vi.fn();
    const view = render(<PinnedSavesSection onSelect={onSelect} query="dluga" />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(6));
    view.rerender(<PinnedSavesSection onSelect={onSelect} query="daily" />);
    fireEvent.click(screen.getByRole("listitem"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ origin: stop1, destination: home }));
  });

  test("filters aliases and origin names without unrelated saved items", async () => {
    const view = render(<PinnedSavesSection onSelect={vi.fn()} query="university" />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("listitem").textContent).toContain("Classes");
    view.rerender(<PinnedSavesSection onSelect={vi.fn()} query="no match" />);
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("per-city saved places", () => {
  test("shows only the active city's saves, never unassigned ones", async () => {
    await seed([
      { id: "here", origin: stop1, alias: "Here", savedAt: 100 },
      { id: "elsewhere", origin: stop2, alias: "Elsewhere", savedAt: 200, cityId: "elsewhere-city" },
    ]);
    await restoreSave("legacy", { origin: home, alias: "Legacy", savedAt: 300 });
    render(<PinnedSavesSection onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("listitem").textContent).toContain("Here");
  });
});
