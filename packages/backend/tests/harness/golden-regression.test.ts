import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

interface GoldenQuery {
  city: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  description: string;
}

interface GoldenResult {
  query: GoldenQuery;
  expectedMinItineraries: number;
  expectedModes: string[];
  maxLatencyMs: number;
}

const GOLDEN_DIR = join(__dirname, "golden-files");

describe("Golden-file regression", () => {
  it("golden-files directory exists", () => {
    expect(existsSync(GOLDEN_DIR)).toBe(true);
  });

  const files = existsSync(GOLDEN_DIR)
    ? readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"))
    : [];

  it("has at least 20 golden files", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  for (const file of files) {
    it(`validates structure: ${file}`, () => {
      const raw = readFileSync(join(GOLDEN_DIR, file), "utf-8");
      const golden: GoldenResult = JSON.parse(raw);
      expect(golden.query.from.lat).toBeTypeOf("number");
      expect(golden.query.from.lon).toBeTypeOf("number");
      expect(golden.query.to.lat).toBeTypeOf("number");
      expect(golden.query.to.lon).toBeTypeOf("number");
      expect(golden.expectedMinItineraries).toBeGreaterThanOrEqual(0);
      expect(golden.maxLatencyMs).toBeGreaterThan(0);
      expect(golden.maxLatencyMs).toBeLessThanOrEqual(5000);
      expect(golden.expectedModes.length).toBeGreaterThan(0);
    });
  }
});
