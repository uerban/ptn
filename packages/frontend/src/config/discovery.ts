import {runtimeCityConfigs} from "./deployment.ts";
import type {CityConfig} from "./cities.ts";

export let catalogWasCached = false;
const CACHE_KEY = "ptn:backend-city-catalog";
export function selectCities(catalog: unknown, policy: unknown): CityConfig[] {
  const cities = runtimeCityConfigs(catalog, []);
  if (!cities?.length || (catalog as {schemaVersion?: unknown}).schemaVersion !== 2) {
    throw new Error("The server returned an unsupported city catalog");
  }
  if (policy === undefined || policy === "all") return cities;
  if (!Array.isArray(policy) || !policy.length || policy.some(id => typeof id !== "string") || new Set(policy).size !== policy.length) {
    throw new Error("Invalid frontend city selection");
  }
  return policy.map(id => {
    const city = cities.find(city => city.id === id);
    if (!city) throw new Error(`This host does not serve configured city: ${id}`);
    return city;
  });
}

/** Fetch before importing App/stores. Only network failures use the last valid
 * catalog; an explicit empty/invalid catalog never resurrects removed cities. */
export async function discoverCities(fetcher: typeof fetch = fetch): Promise<CityConfig[]> {
  catalogWasCached = false;
  const policy = (globalThis.__PTN_DEPLOYMENT__ as {cities?: unknown} | null)?.cities;
  let catalog: unknown;
  let response: Response | undefined;
  try {
    response = await fetcher("/api/cities", {cache: "no-store", signal: AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`City discovery failed (${response.status})`);

  } catch (error) {
    let cached: unknown;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"); } catch { /* Optional storage. */ }
    if (!cached) throw error;
    catalog = cached;
    catalogWasCached = true;
  }
  if (response?.ok) catalog = await response.json();
  const cities = selectCities(catalog, policy);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(catalog)); } catch { /* Optional storage. */ }
  // The rest of the app receives a fully resolved catalog, never a default city.
  globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 2, cities};
  return cities;
}
