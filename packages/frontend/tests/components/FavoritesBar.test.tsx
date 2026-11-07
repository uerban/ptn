import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { BaseEndpoint, FavoritePlace } from "@pt/shared";
import { FavoritesBar } from "../../src/components/Favorites/FavoritesBar.tsx";
import { useFavoritesStore } from "../../src/stores/favoritesStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { db } from "../../src/db/index.ts";
import { restoreSave } from "../../src/services/saves.ts";
import { resetPersonalStorage } from "../../src/test-helpers/personalStorage.ts";

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

function seedSave(
  id: string,
  alias: string,
  endpoint: BaseEndpoint,
  savedAt: number,
  placeType?: FavoritePlace["type"],
) {
  return restoreSave(id, { origin: endpoint, alias, savedAt, placeType });
}

describe("FavoritesBar", () => {
  beforeEach(async () => {
    await resetPersonalStorage();
    await useFavoritesStore.persist.rehydrate();
    useFavoritesStore.setState({ favorites: [] });
    useSettingsStore.setState({ enableFavoritesMigration: false });
  });

  it("reads from favoritesStore when flag is OFF", () => {
    useFavoritesStore.setState({
      favorites: [makeFavorite({ name: "Legacy Home" })],
    });
    const onClick = vi.fn();
    render(<FavoritesBar onFavoriteClick={onClick} />);
    expect(screen.getByText("Legacy Home")).not.toBeNull();
  });

  it("shows a loading placeholder until sealed favorites are decrypted", () => {
    vi.spyOn(useFavoritesStore.persist, "hasHydrated").mockReturnValue(false);
    useFavoritesStore.setState({
      favorites: [makeFavorite({ name: "Not Yet" })],
    });
    render(<FavoritesBar onFavoriteClick={vi.fn()} />);
    expect(screen.getByTestId("favorites-loading")).not.toBeNull();
    expect(screen.queryByText("Not Yet")).toBeNull();
    vi.restoreAllMocks();
  });

  it("ignores savedLocations when flag is OFF", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: false });
    await seedSave(
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
    );
    render(<FavoritesBar onFavoriteClick={vi.fn()} />);
    expect(screen.queryByText("Shadow Saved")).toBeNull();
  });

  it("reads sealed savedLocations when flag is ON", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: true });
    await seedSave(
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

  it("keeps the kind of a migrated favorite (home)", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: true });
    await seedSave(
      "s-home",
      "Dom",
      { kind: "geocoded", lat: 54.35, lon: 18.65, label: "Dom", provider: "bundled", confidence: 1 },
      2000,
      "home",
    );
    expect(await db.savedLocations.count()).toBe(1);
    const onClick = vi.fn();
    render(<FavoritesBar onFavoriteClick={onClick} />);
    await waitFor(() => {
      expect(screen.getByText("Dom")).not.toBeNull();
    });
    fireEvent.click(screen.getByText("Dom"));
    expect((onClick.mock.calls[0][0] as FavoritePlace).type).toBe("home");
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
    await seedSave(
        "s-stop",
        "Central",
        { kind: "stop", stopId: "S-42", name: "Central", lat: 54.37, lon: 18.67 },
        3000,
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
});
