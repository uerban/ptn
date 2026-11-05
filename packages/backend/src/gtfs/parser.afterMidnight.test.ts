import { describe, it, expect } from "vitest";
import { parseTimeToSecs } from "./parser.js";

describe("RAPTOR ingestion of service-day rollover", () => {
  it("interprets 25:30:00 as 91800 seconds-since-start-of-service-day", () => {
    expect(parseTimeToSecs("25:30:00")).toBe(25 * 3600 + 30 * 60);
  });

  it("handles 24:00:00 (canonical midnight rollover boundary)", () => {
    expect(parseTimeToSecs("24:00:00")).toBe(86_400);
  });

  it("handles 27:45:30 (deep post-midnight times still preserved)", () => {
    expect(parseTimeToSecs("27:45:30")).toBe(27 * 3600 + 45 * 60 + 30);
  });

  it("normal HH:MM:SS still works", () => {
    expect(parseTimeToSecs("08:15:30")).toBe(8 * 3600 + 15 * 60 + 30);
  });
});
