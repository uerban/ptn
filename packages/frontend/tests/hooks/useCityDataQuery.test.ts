import { afterEach, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCityDataQuery } from "../../src/hooks/useCityDataQuery.ts";
import { activateCityData, CityDataContext, invalidateCityData } from "../../src/services/cityData.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";

const original = useCityStore.getState().activeCity;
function data(cityId: string, generationId: string, name: string) {
  return new CityDataContext({meta: {cityId, generatedAt: "2026-11-07"}, routes: [], calendar: [],
    stops: [{id: "same-stop", name, lat: 1, lon: 2}]},
    {id: "current", cityId, generationId, etag: generationId, generatedAt: "2026-11-07", lastSynced: 1});
}
afterEach(() => { cleanup(); invalidateCityData(); useCityStore.setState({activeCity: original}); });

it("replaces a same-city generation reactively without any IndexedDB write", async () => {
  const cityId = original.id;
  activateCityData(data(cityId, "a", "A"));
  const {result} = renderHook(() => useCityDataQuery(view => view.gtfsStops.get("same-stop"), []));
  await waitFor(() => expect(result.current?.name).toBe("A"));
  act(() => activateCityData(data(cityId, "b", "B")));
  await waitFor(() => expect(result.current?.name).toBe("B"));
});

it("never holds city A's result while city B's query is pending", async () => {
  activateCityData(data(original.id, "a", "A"));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const {result} = renderHook(() => useCityDataQuery(async view => {
    const stop = await view.gtfsStops.get("same-stop");
    if (view.token?.cityId === "other-city") await gate;
    return stop;
  }, []));
  await waitFor(() => expect(result.current?.name).toBe("A"));
  act(() => {
    useCityStore.setState({activeCity: {...original, id: "other-city"}});
    activateCityData(data("other-city", "b", "B"));
  });
  expect(result.current).toBeUndefined();
  await act(async () => { finish(); await Promise.resolve(); });
  await waitFor(() => expect(result.current?.name).toBe("B"));
});
