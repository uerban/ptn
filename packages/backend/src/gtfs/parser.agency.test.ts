import { describe, it, expect } from "vitest";
import { parseAgency, type GtfsAgency } from "./parser.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseAgency", () => {
  it("extracts agency_timezone (and name/id) per row", async () => {
    const csv = [
      "agency_id,agency_name,agency_url,agency_timezone",
      "a1,Agency One,https://one.example,Europe/Vilnius",
      "a2,Agency Two,https://two.example,Europe/Warsaw",
    ].join("\n");

    const rows = await parseAgency(enc(csv));

    expect(rows).toEqual<GtfsAgency[]>([
      { agencyId: "a1", agencyName: "Agency One", agencyTimezone: "Europe/Vilnius", url: "https://one.example" },
      { agencyId: "a2", agencyName: "Agency Two", agencyTimezone: "Europe/Warsaw", url: "https://two.example" },
    ]);
  });

  it("tolerates a single-agency feed with no agency_id", async () => {
    // agency_id is conditionally-required (optional when the feed has exactly
    // one agency) per the GTFS spec — collapse the missing column to "".
    const csv = [
      "agency_name,agency_url,agency_timezone",
      "Sole Agency,https://sole.example,America/New_York",
    ].join("\n");

    const rows = await parseAgency(enc(csv));

    expect(rows).toEqual<GtfsAgency[]>([
      { agencyId: "", agencyName: "Sole Agency", agencyTimezone: "America/New_York", url: "https://sole.example" },
    ]);
  });

  it("returns [] for an empty buffer (no agency.txt)", async () => {
    const rows = await parseAgency(new Uint8Array(0));
    expect(rows).toEqual([]);
  });

  it("returns [] for header-only input", async () => {
    const rows = await parseAgency(enc("agency_name,agency_url,agency_timezone\n"));
    expect(rows).toEqual([]);
  });
});
