import { describe, expect, it } from "vitest";
import { waitClock, waitSpoken } from "./waitTime.ts";

describe("waitClock", () => {
  it("leaves waits under an hour to the caller", () => {
    expect(waitClock(59, false)).toBeNull();
  });
  it("shows an hour or more as h:mm", () => {
    expect(waitClock(60, false)).toBe("1:00");
    expect(waitClock(65, false)).toBe("1:05");
    expect(waitClock(754, false)).toBe("12:34");
  });
  it("keeps minutes when asked to", () => {
    expect(waitClock(125, true)).toBeNull();
  });
});

describe("waitSpoken", () => {
  it("names hours and minutes in the locale", () => {
    expect(waitSpoken(65, "en")).toBe("1 hour 5 minutes");
    expect(waitSpoken(120, "en")).toBe("2 hours");
  });
});
