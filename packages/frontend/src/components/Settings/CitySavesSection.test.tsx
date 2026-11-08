import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, act, render, screen, waitFor } from "@testing-library/react";
import { CitySavesSection } from "./CitySavesSection.tsx";
import { db } from "../../db/index.ts";
import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";

const endpoint = {kind: "stop" as const, stopId: "S", name: "Stop", lat: 1, lon: 2};
beforeEach(async () => {
  await db.savedLocations.clear();
  useFavoritesStore.setState({favorites: []});
});
afterEach(cleanup);

it("leaves legacy ownership unknown until explicitly assigned in recovery", async () => {
  await db.savedLocations.put({id: "legacy", endpoint, alias: "Old Home", savedAt: 123, encrypted: false});
  render(<CitySavesSection />);
  expect(screen.queryByText("Old Home")).toBeNull();
  expect((await db.savedLocations.get("legacy"))?.cityId).toBeUndefined();
  const details = screen.getByText("Unassigned saved places").closest("details")!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await screen.findByText("Old Home");
  const button = screen.getByRole("button", {name: /Use in/});
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(async () => expect((await db.savedLocations.get("legacy"))?.cityId).toBe(useCityStore.getState().activeCity.id));
  expect((await db.savedLocations.get("legacy"))?.savedAt).toBe(123);
});

it("does not expose a migrated legacy copy twice", async () => {
  await db.savedLocations.put({id: "same", endpoint, alias: "Saved copy", savedAt: 1, encrypted: false});
  useFavoritesStore.setState({favorites: [{id: "same", name: "Legacy copy", type: "home", location: {lat: 1, lon: 2}, sortOrder: 0, createdAt: "2026-01-01"}]});
  render(<CitySavesSection />);
  const details = screen.getByText("Unassigned saved places").closest("details")!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await screen.findByText("Saved copy");
  expect(screen.queryByText("Legacy copy")).toBeNull();
  expect(screen.getAllByRole("button", {name: /Use in/})).toHaveLength(1);
});
