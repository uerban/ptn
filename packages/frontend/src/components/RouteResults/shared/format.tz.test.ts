/**
 * formatTime renders the instant in the supplied feed tz, not the device tz.
 *
 * The exact-value assertions below pin the projected wall-clock; the
 * cross-tz assertion (Tokyo vs Vilnius for the same instant) is what makes
 * this test discriminate on ANY host timezone — the legacy 2-arg formatTime
 * ignored its 3rd argument, so it would render both zones identically (the
 * host's wall-clock) and the inequality assertion would fail. With the tz
 * threaded through, the two zones must differ.
 */
import { describe, expect, it } from "vitest";
import { formatTime } from "./format.ts";

describe("formatTime tz-aware", () => {
  it("formats an instant in the feed tz when given one", () => {
    // 2026-01-15 22:30 UTC = 2026-01-16 00:30 in Europe/Vilnius (+02:00).
    const iso = new Date(Date.UTC(2026, 0, 15, 22, 30, 0)).toISOString();
    expect(formatTime(iso, "en-GB", "Europe/Vilnius")).toBe("00:30");
  });

  it("renders the SAME instant differently in different feed tzs (host-tz-independent)", () => {
    // 2026-01-15 22:30 UTC = 00:30 in Vilnius (+02) and 07:30 in Tokyo (+09).
    const iso = new Date(Date.UTC(2026, 0, 15, 22, 30, 0)).toISOString();
    expect(formatTime(iso, "en-GB", "Asia/Tokyo")).toBe("07:30");
    // The two must differ — the legacy 2-arg formatTime ignored the tz arg
    // and would render both as the host wall-clock (equal), failing this.
    expect(formatTime(iso, "en-GB", "Asia/Tokyo")).not.toBe(
      formatTime(iso, "en-GB", "Europe/Vilnius"),
    );
  });

  it("without a tz, formats in the device tz (legacy local-user path)", () => {
    const iso = new Date(Date.UTC(2026, 0, 15, 22, 30, 0)).toISOString();
    // No throw, returns a HH:MM string (device-dependent value).
    expect(formatTime(iso, "en-GB")).toMatch(/^\d{2}:\d{2}$/);
  });
});
