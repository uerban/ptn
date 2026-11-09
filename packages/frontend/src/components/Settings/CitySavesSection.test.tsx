import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, act, render, screen, waitFor } from "@testing-library/react";
import { CitySavesSection } from "./CitySavesSection.tsx";
import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { listSaves, restoreSave } from "../../services/saves.ts";
import { resetPersonalStorage } from "../../test-helpers/personalStorage.ts";
import { canonicalCityId } from "../../utils/cityId.ts";

const endpoint = {kind: "stop" as const, stopId: "S", name: "Stop", lat: 1, lon: 2};
const saveById = async (id: string) => (await listSaves()).find(save => save.id === id);
beforeEach(async () => {
  await resetPersonalStorage();
  useFavoritesStore.setState({favorites: []});
});
afterEach(cleanup);

async function openRecovery() {
  const details = screen.getByText("Unassigned saved places").closest("details")!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

it("leaves legacy ownership unknown until explicitly assigned in recovery", async () => {
  await restoreSave("legacy", {origin: endpoint, alias: "Old Home", savedAt: 123});
  render(<CitySavesSection />);
  expect(screen.queryByText("Old Home")).toBeNull();
  expect((await saveById("legacy"))?.cityId).toBeUndefined();
  await openRecovery();
  await screen.findByText("Old Home");
  const button = screen.getByRole("button", {name: /Use in/});
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(async () => expect((await saveById("legacy"))?.cityId).toBe(canonicalCityId(useCityStore.getState().activeCity.id)));
  expect((await saveById("legacy"))?.savedAt).toBe(123);
});

it("does not expose a migrated legacy copy twice", async () => {
  await restoreSave("same", {origin: endpoint, alias: "Saved copy", savedAt: 1});
  useFavoritesStore.setState({favorites: [{id: "same", name: "Legacy copy", type: "home", location: {lat: 1, lon: 2}, sortOrder: 0, createdAt: "2026-01-01"}]});
  render(<CitySavesSection />);
  await openRecovery();
  await screen.findByText("Saved copy");
  expect(screen.queryByText("Legacy copy")).toBeNull();
  expect(screen.getAllByRole("button", {name: /Use in/})).toHaveLength(1);
});
