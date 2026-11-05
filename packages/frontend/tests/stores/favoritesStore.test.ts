import { describe, it, expect, beforeEach } from "vitest";
import { useFavoritesStore } from "../../src/stores/favoritesStore.ts";

describe("favoritesStore", () => {
  beforeEach(() => {
    // Reset store state between tests
    useFavoritesStore.setState({ favorites: [] });
  });

  it("starts with empty favorites", () => {
    expect(useFavoritesStore.getState().favorites).toEqual([]);
  });

  it("addFavorite adds a favorite with generated fields", () => {
    useFavoritesStore.getState().addFavorite({
      name: "Home",
      type: "home",
      location: { lat: 54.687, lon: 25.279 },
    });

    const favorites = useFavoritesStore.getState().favorites;
    expect(favorites).toHaveLength(1);
    expect(favorites[0].name).toBe("Home");
    expect(favorites[0].type).toBe("home");
    expect(favorites[0].location).toEqual({ lat: 54.687, lon: 25.279 });
    expect(favorites[0].id).toBeDefined();
    expect(favorites[0].sortOrder).toBe(0);
    expect(favorites[0].createdAt).toBeDefined();
  });

  it("addFavorite assigns incrementing sortOrder", () => {
    const { addFavorite } = useFavoritesStore.getState();
    addFavorite({ name: "Home", type: "home", location: { lat: 1, lon: 1 } });
    addFavorite({ name: "Work", type: "work", location: { lat: 2, lon: 2 } });
    addFavorite({ name: "Gym", type: "place", location: { lat: 3, lon: 3 } });

    const favorites = useFavoritesStore.getState().favorites;
    expect(favorites).toHaveLength(3);
    expect(favorites[0].sortOrder).toBe(0);
    expect(favorites[1].sortOrder).toBe(1);
    expect(favorites[2].sortOrder).toBe(2);
  });

  it("removeFavorite removes by id and reindexes sortOrder", () => {
    const { addFavorite } = useFavoritesStore.getState();
    addFavorite({ name: "Home", type: "home", location: { lat: 1, lon: 1 } });
    addFavorite({ name: "Work", type: "work", location: { lat: 2, lon: 2 } });
    addFavorite({ name: "Gym", type: "place", location: { lat: 3, lon: 3 } });

    const idToRemove = useFavoritesStore.getState().favorites[1].id;
    useFavoritesStore.getState().removeFavorite(idToRemove);

    const favorites = useFavoritesStore.getState().favorites;
    expect(favorites).toHaveLength(2);
    expect(favorites[0].name).toBe("Home");
    expect(favorites[1].name).toBe("Gym");
    expect(favorites[0].sortOrder).toBe(0);
    expect(favorites[1].sortOrder).toBe(1);
  });

  it("removeFavorite is a no-op for unknown id", () => {
    const { addFavorite } = useFavoritesStore.getState();
    addFavorite({ name: "Home", type: "home", location: { lat: 1, lon: 1 } });

    useFavoritesStore.getState().removeFavorite("nonexistent-id");
    expect(useFavoritesStore.getState().favorites).toHaveLength(1);
  });

  it("reorderFavorites reorders by given ID list", () => {
    const { addFavorite } = useFavoritesStore.getState();
    addFavorite({ name: "A", type: "place", location: { lat: 1, lon: 1 } });
    addFavorite({ name: "B", type: "place", location: { lat: 2, lon: 2 } });
    addFavorite({ name: "C", type: "place", location: { lat: 3, lon: 3 } });

    const [a, b, c] = useFavoritesStore.getState().favorites;
    useFavoritesStore.getState().reorderFavorites([c.id, a.id, b.id]);

    const favorites = useFavoritesStore.getState().favorites;
    expect(favorites[0].name).toBe("C");
    expect(favorites[1].name).toBe("A");
    expect(favorites[2].name).toBe("B");
    expect(favorites[0].sortOrder).toBe(0);
    expect(favorites[1].sortOrder).toBe(1);
    expect(favorites[2].sortOrder).toBe(2);
  });

  it("reorderFavorites ignores unknown IDs", () => {
    const { addFavorite } = useFavoritesStore.getState();
    addFavorite({ name: "A", type: "place", location: { lat: 1, lon: 1 } });
    addFavorite({ name: "B", type: "place", location: { lat: 2, lon: 2 } });

    const [a, b] = useFavoritesStore.getState().favorites;
    useFavoritesStore.getState().reorderFavorites([b.id, "fake-id", a.id]);

    const favorites = useFavoritesStore.getState().favorites;
    expect(favorites).toHaveLength(2);
    expect(favorites[0].name).toBe("B");
    expect(favorites[1].name).toBe("A");
  });

  it("addFavorite with stopId preserves it", () => {
    useFavoritesStore.getState().addFavorite({
      name: "Stotis",
      type: "stop",
      location: { lat: 54.6719, lon: 25.2834 },
      stopId: "lt-vilnius_16581",
    });

    const fav = useFavoritesStore.getState().favorites[0];
    expect(fav.stopId).toBe("lt-vilnius_16581");
  });
});
