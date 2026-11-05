import { describe, it, expect, vi } from "vitest";
import { strToU8 } from "fflate";
import {
  parseStops,
  withCaps,
} from "./parser.js";

function csv(header: string, rows: string[]): Uint8Array {
  return strToU8([header, ...rows].join("\n") + "\n");
}

const STOPS_HEADER = "stop_id,stop_name,stop_lat,stop_lon";

function stopRows(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`s${i},Stop ${i},0,0`);
  return out;
}

describe("withCaps", () => {
  it("parseStops throws when row count exceeds cap", async () => {
    const data = csv(STOPS_HEADER, stopRows(10));
    const p = withCaps({ stops: 5, routes: 1000, trips: 1000, services: 1000, calendarDates: 1000 });
    await expect(p.parseStops(data)).rejects.toThrow(/stops|cap/i);
  });

  it("parseStops passes when under cap", async () => {
    const data = csv(STOPS_HEADER, stopRows(3));
    const p = withCaps({ stops: 5, routes: 1000, trips: 1000, services: 1000, calendarDates: 1000 });
    const result = await p.parseStops(data);
    expect(result).toHaveLength(3);
  });

  it("parseStops warns on stderr at 80% of cap", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const data = csv(STOPS_HEADER, stopRows(9));
      const p = withCaps({ stops: 10, routes: 1000, trips: 1000, services: 1000, calendarDates: 1000 });
      await p.parseStops(data);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/80%|stops/));
    } finally {
      spy.mockRestore();
    }
  });

  it("parseStops does NOT warn when under 80%", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const data = csv(STOPS_HEADER, stopRows(7));
      const p = withCaps({ stops: 10, routes: 1000, trips: 1000, services: 1000, calendarDates: 1000 });
      await p.parseStops(data);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("cap-aware versions are drop-in replacements for the uncapped ones", async () => {
    const data = csv(STOPS_HEADER, stopRows(3));
    const direct = await parseStops(data);
    const p = withCaps({ stops: 100, routes: 100, trips: 100, services: 100, calendarDates: 100 });
    const capped = await p.parseStops(data);
    expect(capped).toEqual(direct);
  });
});
