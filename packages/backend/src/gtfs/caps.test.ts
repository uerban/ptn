import { describe, it, expect, afterEach } from "vitest";
import { readCaps } from "./caps.js";

const KEYS = [
  "PT_CAP_TRIPS",
  "PT_CAP_STOPS",
  "PT_CAP_ROUTES",
  "PT_CAP_SERVICES",
  "PT_CAP_CALENDAR_DATES",
  "PT_CAP_ZIP_COMPRESSED_BYTES",
  "PT_CAP_ZIP_UNCOMPRESSED_BYTES",
  "PT_CAP_ZIP_PER_ENTRY_BYTES",
  "PT_CAP_ZIP_MEMBERS",
  "PT_CAP_ZIP_COMPRESSION_RATIO",
  "PT_CAP_SHAPES",
  "PT_CAP_POINTS_PER_SHAPE",
  "PT_CAP_SHAPES_ENCODED_BYTES",
] as const;

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

describe("readCaps", () => {
  afterEach(clearEnv);

  it("returns sensible defaults when no env set", () => {
    clearEnv();
    const caps = readCaps();
    expect(caps.trips).toBe(2_000_000);
    expect(caps.stops).toBe(500_000);
    expect(caps.routes).toBe(50_000);
    expect(caps.services).toBe(100_000);
    expect(caps.calendarDates).toBe(1_000_000);
    expect(caps.zipCompressedBytes).toBe(1_073_741_824);
    expect(caps.zipUncompressedBytes).toBe(2_147_483_648);
    expect(caps.zipPerEntryBytes).toBe(1_610_612_736);
    expect(caps.zipMembers).toBe(1000);
    expect(caps.zipCompressionRatio).toBe(100);
  });

  it("env overrides defaults", () => {
    clearEnv();
    process.env.PT_CAP_TRIPS = "3000000";
    process.env.PT_CAP_ZIP_MEMBERS = "2000";
    const caps = readCaps();
    expect(caps.trips).toBe(3_000_000);
    expect(caps.zipMembers).toBe(2000);
    expect(caps.stops).toBe(500_000);
  });

  it("throws on non-numeric env", () => {
    clearEnv();
    process.env.PT_CAP_TRIPS = "not-a-number";
    expect(() => readCaps()).toThrow(/PT_CAP_TRIPS/);
  });

  it("throws on zero or negative cap", () => {
    clearEnv();
    process.env.PT_CAP_STOPS = "0";
    expect(() => readCaps()).toThrow(/PT_CAP_STOPS/);
    process.env.PT_CAP_STOPS = "-5";
    expect(() => readCaps()).toThrow(/PT_CAP_STOPS/);
  });
});

describe("shape caps", () => {
  afterEach(clearEnv);

  it("defaults: shapesCount=50000, pointsPerShape=10000, shapesEncodedBytes=4MiB", () => {
    delete process.env.PT_CAP_SHAPES;
    delete process.env.PT_CAP_POINTS_PER_SHAPE;
    delete process.env.PT_CAP_SHAPES_ENCODED_BYTES;
    const c = readCaps();
    expect(c.shapesCount).toBe(50_000);
    expect(c.pointsPerShape).toBe(10_000);
    expect(c.shapesEncodedBytes).toBe(4 * 1024 * 1024);
  });

  it("env overrides respected", () => {
    process.env.PT_CAP_SHAPES = "100";
    process.env.PT_CAP_POINTS_PER_SHAPE = "200";
    process.env.PT_CAP_SHAPES_ENCODED_BYTES = "12345";
    const c = readCaps();
    expect(c.shapesCount).toBe(100);
    expect(c.pointsPerShape).toBe(200);
    expect(c.shapesEncodedBytes).toBe(12345);
  });
});
