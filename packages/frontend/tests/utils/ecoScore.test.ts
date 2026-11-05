import { describe, it, expect } from "vitest";
import { computeEcoScore } from "../../src/utils/ecoScore.ts";
import type { Leg } from "@pt/shared";

function makeLeg(overrides: Partial<Leg>): Leg {
  return {
    mode: "BUS",
    from: { name: "A", location: { lat: 0, lon: 0 } },
    to: { name: "B", location: { lat: 0, lon: 0 } },
    departureTime: "2026-04-10T10:00:00Z",
    arrivalTime: "2026-04-10T10:15:00Z",
    durationSeconds: 900,
    ...overrides,
  };
}

describe("computeEcoScore", () => {
  it("bus-only trip saves ~58% vs car", () => {
    // 10 km bus trip: transit = 10 * 50 = 500g, car = 10 * 120 = 1200g
    // savings = 700g / 1200g = 58.33% -> rounds to 58%
    const legs: Leg[] = [makeLeg({ mode: "BUS", distanceMeters: 10_000 })];
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(500);
    expect(eco.carCO2g).toBe(1200);
    expect(eco.savingsPercent).toBe(58);
    expect(eco.savingsKg).toBe(0.7);
  });

  it("walking-only trip saves 100%", () => {
    const legs: Leg[] = [makeLeg({ mode: "WALK", distanceMeters: 2000 })];
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(0);
    expect(eco.carCO2g).toBe(240);
    expect(eco.savingsPercent).toBe(100);
    expect(eco.savingsKg).toBe(0.24);
  });

  it("mixed mode (walk + tram) calculates correctly", () => {
    // Walk 500m (0g) + Tram 5km (5 * 20 = 100g) = 100g transit
    // Car: 5.5km * 120 = 660g
    // Savings: 560/660 = 84.8% -> rounds to 85%
    const legs: Leg[] = [
      makeLeg({ mode: "WALK", distanceMeters: 500 }),
      makeLeg({ mode: "TRAM", distanceMeters: 5000 }),
    ];
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(100);
    expect(eco.carCO2g).toBe(660);
    expect(eco.savingsPercent).toBe(85);
    expect(eco.savingsKg).toBe(0.56);
  });

  it("zero distance returns zeros", () => {
    const legs: Leg[] = [makeLeg({ mode: "BUS" })]; // no distanceMeters
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(0);
    expect(eco.carCO2g).toBe(0);
    expect(eco.savingsPercent).toBe(0);
    expect(eco.savingsKg).toBe(0);
  });

  it("empty legs array returns zeros", () => {
    const eco = computeEcoScore([]);

    expect(eco.transitCO2g).toBe(0);
    expect(eco.carCO2g).toBe(0);
    expect(eco.savingsPercent).toBe(0);
    expect(eco.savingsKg).toBe(0);
  });

  it("rail trip saves ~83% vs car", () => {
    // 20 km rail: transit = 20 * 20 = 400g, car = 20 * 120 = 2400g
    // savings = 2000 / 2400 = 83.33% -> rounds to 83%
    const legs: Leg[] = [makeLeg({ mode: "RAIL", distanceMeters: 20_000 })];
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(400);
    expect(eco.carCO2g).toBe(2400);
    expect(eco.savingsPercent).toBe(83);
    expect(eco.savingsKg).toBe(2);
  });

  it("ferry trip saves ~33% vs car", () => {
    // 3 km ferry: transit = 3 * 80 = 240g, car = 3 * 120 = 360g
    // savings = 120 / 360 = 33.33% -> rounds to 33%
    const legs: Leg[] = [makeLeg({ mode: "FERRY", distanceMeters: 3000 })];
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(240);
    expect(eco.carCO2g).toBe(360);
    expect(eco.savingsPercent).toBe(33);
    expect(eco.savingsKg).toBe(0.12);
  });

  it("unknown mode defaults to BUS factor", () => {
    const legs: Leg[] = [makeLeg({ mode: "CAR" as any, distanceMeters: 10_000 })];
    // CAR is in the table at 120, so transit = car = 1200g, savings = 0%
    const eco = computeEcoScore(legs);

    expect(eco.transitCO2g).toBe(1200);
    expect(eco.carCO2g).toBe(1200);
    expect(eco.savingsPercent).toBe(0);
  });
});
