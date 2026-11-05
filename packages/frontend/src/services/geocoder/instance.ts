import { GeocoderRegistry } from "./registry.ts";
import { BundledGeocoderAdapter } from "./BundledGeocoderAdapter.ts";
import { useCityStore } from "../../stores/cityStore.ts";

// Process-wide singleton. Adapters are registered lazily by their owning
// modules (M7c bundled local adapter, M9 self-hosted, M10 third-party).
export const geocoderRegistry = new GeocoderRegistry();

geocoderRegistry.register(
  new BundledGeocoderAdapter(() => useCityStore.getState().activeCity.id),
);
