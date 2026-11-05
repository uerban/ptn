import type { Leg } from "@pt/shared";

export interface EcoScore {
  transitCO2g: number;
  carCO2g: number;
  savingsPercent: number;
  savingsKg: number;
}

/** Grams of CO2 per passenger-km by transport mode (European averages). */
export const CO2_PER_KM: Record<string, number> = {
  CAR: 120,
  BUS: 50,
  TRAM: 20,
  TROLLEYBUS: 20,
  METRO: 20,
  RAIL: 20,
  FERRY: 80,
  CABLE_TRAM: 20,
  AERIAL: 20,
  OTHER: 50,
  FUNICULAR: 20,
  WALK: 0,
  BIKE: 0,
  BIKE_SHARE: 0,
  SCOOTER: 30,
};

/**
 * Compute the environmental impact of a transit itinerary compared to driving.
 *
 * Uses mode-weighted CO2 emissions per passenger-km to calculate total transit
 * emissions, then compares against an equivalent car trip over the same distance.
 */
export function computeEcoScore(legs: Leg[]): EcoScore {
  let transitCO2g = 0;
  let totalDistanceKm = 0;

  for (const leg of legs) {
    const distKm = (leg.distanceMeters ?? 0) / 1000;
    totalDistanceKm += distKm;
    const factor = CO2_PER_KM[leg.mode] ?? CO2_PER_KM.BUS;
    transitCO2g += distKm * factor;
  }

  const carCO2g = totalDistanceKm * CO2_PER_KM.CAR;
  const savingsG = carCO2g - transitCO2g;

  return {
    transitCO2g: Math.round(transitCO2g),
    carCO2g: Math.round(carCO2g),
    savingsPercent: carCO2g > 0 ? Math.round((savingsG / carCO2g) * 100) : 0,
    savingsKg: Math.round(savingsG) / 1000,
  };
}
