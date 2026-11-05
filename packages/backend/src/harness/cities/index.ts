import type { CityProfile } from "@pt/shared";
import { vilniusProfile } from "./vilnius.js";
import { tricityProfile } from "./tricity.js";
import { krakowProfile } from "./krakow.js";
import { parisProfile } from "./paris.js";
import { osloProfile } from "./oslo.js";
import { tbilisiProfile } from "./tbilisi.js";

/** All registered city profiles, keyed by city ID */
export const cityProfiles: Record<string, CityProfile> = {
  vilnius: vilniusProfile,
  tricity: tricityProfile,
  krakow: krakowProfile,
  paris: parisProfile,
  oslo: osloProfile,
  tbilisi: tbilisiProfile,
};

export function getCityProfile(cityId: string): CityProfile | undefined {
  return cityProfiles[cityId.toLowerCase()];
}

export function listCityIds(): string[] {
  return Object.keys(cityProfiles);
}

export {
  vilniusProfile,
  tricityProfile,
  krakowProfile,
  parisProfile,
  osloProfile,
  tbilisiProfile,
};
