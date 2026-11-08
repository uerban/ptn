import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { BaseEndpoint, FavoritePlace } from "@pt/shared";
import { FavoritesBar } from "../../src/components/Favorites/FavoritesBar.tsx";
import { useFavoritesStore } from "../../src/stores/favoritesStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { db, type SavedLocationRecord } from "../../src/db/index.ts";
import { encrypt } from "../../src/services/cryptoBox.ts";
import {
  getOrCreateInstallKey,
  __resetInstallKeyCacheForTests,
} from "../../src/services/installKey.ts";
import { __resetDegradedModeForTests } from "../../src/services/installKeyDegrade.ts";

function makeFavorite(overrides: Partial<FavoritePlace> = {}): FavoritePlace {
  return {
    id: "fav-1",
    name: "Home",
    type: "home",
    location: { lat: 54.35, lon: 18.65 },
    sortOrder: 0,
    createdAt: "2026-01-01T10:00:00.000Z",
    cityId: useCityStore.getState().activeCity.id,
    ...overrides,
  };
}

function plaintextSaved(
  id: string,
  alias: string,
  endpoint: BaseEndpoint,
  savedAt: number,
): SavedLocationRecord {
  return { id, cityId: useCityStore.getState().activeCity.id, alias, savedAt, encrypted: false, endpoint };
}

describe("FavoritesBar", () => {
  beforeEach(async () => {
    useFavoritesStore.setState({ favorites: [] });
    useSettingsStore.setState({ enableFavoritesMigration: false });
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
  });

  it("reads from favoritesStore when flag is OFF", () => {
    useFavoritesStore.setState({
      favorites: [makeFavorite({ name: "Legacy Home" })],
    });
    const onClick = vi.fn();
    render(<FavoritesBar onFavoriteClick={onClick} />);
    expect(screen.getByText("Legacy Home")).not.toBeNull();
  });

  it("ignores savedLocations when flag is OFF", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: false });
    await db.savedLocations.put(
      plaintextSaved(
        "s-1",
        "Shadow Saved",
        {
          kind: "geocoded",
          lat: 1,
          lon: 2,
          label: "Shadow Saved",
          provider: "bundled",
          confidence: 1,
        },
        1,
      ),
    );
    render(<FavoritesBar onFavoriteClick={vi.fn()} />);
    expect(screen.queryByText("Shadow Saved")).toBeNull();
  });

  it("reads from savedLocations when flag is ON (plaintext)", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: true });
    await db.savedLocations.put(
      plaintextSaved(
        "s-1",
        "Rynek",
        {
          kind: "geocoded",
          lat: 54.38,
          lon: 18.68,
          label: "Rynek",
          provider: "bundled",
          confidence: 1,
        },
        1000,
      ),
    );
    const onClick = vi.fn();
    render(<FavoritesBar onFavoriteClick={onClick} />);
    await waitFor(() => {
      expect(screen.getByText("Rynek")).not.toBeNull();
    });
    fireEvent.click(screen.getByText("Rynek"));
    expect(onClick).toHaveBeenCalledTimes(1);
    const arg = onClick.mock.calls[0][0] as FavoritePlace;
    expect(arg.id).toBe("s-1");
    expect(arg.location).toEqual({ lat: 54.38, lon: 18.68 });
    expect(arg.stopId).toBeUndefined();
  });

  it("reads and decrypts encrypted savedLocations when flag is ON", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: true });
    const key = await getOrCreateInstallKey();
    const endpoint: BaseEndpoint = {
      kind: "geocoded",
      lat: 54.35,
      lon: 18.65,
      label: "Dom",
      provider: "bundled",
      confidence: 1,
    };
    const sealed = await encrypt(endpoint, key);
    await db.savedLocations.put({
      id: "s-home",
      cityId: useCityStore.getState().activeCity.id,
      alias: "Dom",
      savedAt: 2000,
      encrypted: true,
      endpoint: sealed,
    });
    render(<FavoritesBar onFavoriteClick={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Dom")).not.toBeNull();
    });
  });

  it("renders nothing when savedLocations is empty and flag ON", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: true });
    const { container } = render(<FavoritesBar onFavoriteClick={vi.fn()} />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("maps stop-kind endpoints back to stopId for the callback", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: true });
    await db.savedLocations.put(
      plaintextSaved(
        "s-stop",
        "Central",
        { kind: "stop", stopId: "S-42", name: "Central", lat: 54.37, lon: 18.67 },
        3000,
      ),
    );
    const onClick = vi.fn();
    render(<FavoritesBar onFavoriteClick={onClick} />);
    await waitFor(() => {
      expect(screen.getByText("Central")).not.toBeNull();
    });
    fireEvent.click(screen.getByText("Central"));
    const arg = onClick.mock.calls[0][0] as FavoritePlace;
    expect(arg.stopId).toBe("S-42");
    expect(arg.type).toBe("stop");
  });
  it("shows only the selected city's places and clears old results before the next city decrypts", async () => {
    useSettingsStore.setState({enableFavoritesMigration: true});
    const original = useCityStore.getState().activeCity;
    try {
      useCityStore.setState({activeCity: {...original, id: "city-a"}});
      const endpoint: BaseEndpoint = {kind: "mappoint", lat: 1, lon: 2};
      await db.savedLocations.bulkPut([
        {...plaintextSaved("a", "A Home", endpoint, 1), cityId: "city-a"},
        {...plaintextSaved("b", "B Home", endpoint, 1), cityId: "city-b"},
        {...plaintextSaved("unknown", "Unknown Home", endpoint, 1), cityId: undefined},
      ]);
      render(<FavoritesBar onFavoriteClick={vi.fn()} />);
      await screen.findByText("A Home");
      expect(screen.queryByText("B Home")).toBeNull();
      expect(screen.queryByText("Unknown Home")).toBeNull();
      act(() => useCityStore.setState({activeCity: {...original, id: "city-b"}}));
      expect(screen.queryByText("A Home")).toBeNull();
      await screen.findByText("B Home");
    } finally { act(() => useCityStore.setState({activeCity: original})); }
  });

  it("keeps Home/Work/place legacy shortcuts city-bound and leaves unassigned records for recovery", () => {
    const cityId = useCityStore.getState().activeCity.id;
    useFavoritesStore.setState({favorites: [
      makeFavorite({id: "a", name: "Current Home", cityId}),
      makeFavorite({id: "b", name: "Other Work", type: "work", cityId: "other"}),
      makeFavorite({id: "c", name: "Unknown Place", type: "place", cityId: undefined}),
    ]});
    render(<FavoritesBar onFavoriteClick={vi.fn()} />);
    expect(screen.getByText("Current Home")).not.toBeNull();
    expect(screen.queryByText("Other Work")).toBeNull();
    expect(screen.queryByText("Unknown Place")).toBeNull();
    expect(useFavoritesStore.getState().favorites).toHaveLength(3);
  });

});
