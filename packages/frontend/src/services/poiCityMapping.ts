import {CITIES} from "../config/cities.ts";

/** Multi-area artifact IDs are declarative metadata, shared by presets and hosts. */
export function poiCityIds(frontendCityId: string): string[] {
  return [...(CITIES.find(city => city.id === frontendCityId)?.poiCityIds ?? [frontendCityId])];
}
