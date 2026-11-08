import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import type { BaseEndpoint } from "@pt/shared";
import { PinnedSavesSection, type ResolvedSave } from "./PinnedSavesSection.tsx";
import { db, type SavedLocationRecord } from "../../db/index.ts";
import { saveRoutePair } from "../../services/saves.ts";
import { __clearRamStoreForTests } from "../../services/cryptoBox.ts";
import { __resetInstallKeyCacheForTests } from "../../services/installKey.ts";
import { __resetDegradedModeForTests } from "../../services/installKeyDegrade.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

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
  __clearRamStoreForTests();
});

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await db.savedLocations.clear();
  await db.installKey.clear();
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __clearRamStoreForTests();
  usePrivacyStore.getState().reset();
});

describe("PinnedSavesSection", () => {
  test("renders nothing when there are no saves", async () => {
    const { container } = render(
      <PinnedSavesSection onSelect={vi.fn()} rowsOverride={[]} />,
    );
    await waitFor(() => {
      expect(container.querySelector("[role=list]")).toBeNull();
    });
  });

  test("renders saves sorted by savedAt DESC", async () => {
    const rows: SavedLocationRecord[] = [
      { id: "old", endpoint: stop1, alias: "Old", savedAt: 100, encrypted: false },
      { id: "new", endpoint: stop2, alias: "New", savedAt: 500, encrypted: false },
      { id: "mid", endpoint: home, alias: "Mid", savedAt: 300, encrypted: false },
    ];
    render(<PinnedSavesSection onSelect={vi.fn()} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("New");
    expect(items[1]!.textContent).toContain("Mid");
    expect(items[2]!.textContent).toContain("Old");
  });

  test("invokes onSelect with the resolved save when clicked", async () => {
    const rows: SavedLocationRecord[] = [
      { id: "a", endpoint: stop1, alias: "Home", savedAt: 100, encrypted: false },
    ];
    const onSelect = vi.fn();
    render(<PinnedSavesSection onSelect={onSelect} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => screen.getByRole("listitem"));
    fireEvent.click(screen.getByRole("listitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0]![0] as ResolvedSave;
    expect(arg.id).toBe("a");
    expect(arg.alias).toBe("Home");
    expect(arg.origin).toEqual(stop1);
    expect(arg.destination).toBeUndefined();
  });

  test("decrypts encrypted saves and exposes both endpoints for pairs", async () => {
    await saveRoutePair(
      { origin: stop1, destination: home, alias: "Daily" },
      { tier: "encrypted", now: () => 9_000, id: "pair-1" },
    );
    const rows = await db.savedLocations.toArray();

    const onSelect = vi.fn();
    render(<PinnedSavesSection onSelect={onSelect} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => screen.getByRole("listitem"));
    fireEvent.click(screen.getByRole("listitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0]![0] as ResolvedSave;
    expect(arg.alias).toBe("Daily");
    expect(arg.origin).toEqual(stop1);
    expect(arg.destination).toEqual(home);
  });

  test("decrypts the aliasCipher at Paranoid and surfaces the label", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    await saveRoutePair(
      { origin: stop1, destination: home, alias: "Therapist" },
      { now: () => 9_000, id: "pair-p" },
    );
    const rows = await db.savedLocations.toArray();
    expect(rows[0]!.alias).toBe("");
    expect(rows[0]!.aliasCipher).toBeDefined();

    const onSelect = vi.fn();
    render(<PinnedSavesSection onSelect={onSelect} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => screen.getByRole("listitem"));
    expect(screen.getByRole("listitem").textContent).toContain("Therapist");
    fireEvent.click(screen.getByRole("listitem"));
    const arg = onSelect.mock.calls[0]![0] as ResolvedSave;
    expect(arg.alias).toBe("Therapist");
    expect(arg.origin).toEqual(stop1);
    expect(arg.destination).toEqual(home);
  });

  test("falls back to a derived label when alias is empty", async () => {
    const rows: SavedLocationRecord[] = [
      { id: "x", endpoint: stop1, alias: "", savedAt: 100, encrypted: false },
    ];
    render(<PinnedSavesSection onSelect={vi.fn()} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => screen.getByRole("listitem"));
    expect(screen.getByRole("listitem").textContent).toContain("Central");
  });

  test("renders pair label as origin → destination when alias empty", async () => {
    const rows: SavedLocationRecord[] = [
      {
        id: "p",
        endpoint: stop1,
        destinationEndpoint: stop2,
        alias: "",
        savedAt: 100,
        encrypted: false,
      },
    ];
    render(<PinnedSavesSection onSelect={vi.fn()} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => screen.getByRole("listitem"));
    const text = screen.getByRole("listitem").textContent ?? "";
    expect(text).toContain("Central");
    expect(text).toContain("University");
  });
});

describe("searchable saved places and trips", () => {
  const rows: SavedLocationRecord[] = [
    { id: "pair", endpoint: stop1, destinationEndpoint: home, alias: "Daily trip", savedAt: 100, encrypted: false },
    { id: "stop", endpoint: stop2, alias: "Classes", savedAt: 200, encrypted: false },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `home-${index}`, endpoint: home, alias: `Home ${index}`, savedAt: 300 + index, encrypted: false })),
  ];

  test("bounds the empty-query preview and exposes the full collection", async () => {
    render(<PinnedSavesSection onSelect={vi.fn()} rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Show all saved items (7)" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  test("matches normalized destination names and keeps both saved-trip endpoints", async () => {
    const onSelect = vi.fn();
    const view = render(<PinnedSavesSection onSelect={onSelect} query="dluga" rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(6));
    view.rerender(<PinnedSavesSection onSelect={onSelect} query="daily" rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    fireEvent.click(screen.getByRole("listitem"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ origin: stop1, destination: home }));
  });

  test("filters aliases and origin names without unrelated saved items", async () => {
    const view = render(<PinnedSavesSection onSelect={vi.fn()} query="university" rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("listitem").textContent).toContain("Classes");
    view.rerender(<PinnedSavesSection onSelect={vi.fn()} query="no match" rowsOverride={rows.map(row => ({ ...row, cityId: row.cityId ?? useCityStore.getState().activeCity.id }))} />);
    expect(screen.queryByRole("list")).toBeNull();
  });
});
