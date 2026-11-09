import { describe, expect, it } from "vitest";
import { LATEST_WHATS_NEW_ID, unseenWhatsNewEntries, WHATS_NEW_ENTRIES } from "./whatsNew.ts";

describe("What's new entries", () => {
  it("lists entries oldest first with positive, increasing ids", () => {
    const ids = WHATS_NEW_ENTRIES.map((entry) => entry.id);
    expect(ids.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1])).toBe(true);
    expect(WHATS_NEW_ENTRIES.some((entry) => entry.topic === "service-alerts")).toBe(true);
    expect(LATEST_WHATS_NEW_ID).toBe(Math.max(...ids));
  });

  it("existing installations have the alerts entry unseen; setup marks everything seen", () => {
    expect(unseenWhatsNewEntries({ seenWhatsNew: 0 }).map((e) => e.topic)).toContain("service-alerts");
    expect(unseenWhatsNewEntries({ seenWhatsNew: LATEST_WHATS_NEW_ID })).toEqual([]);
    expect(unseenWhatsNewEntries(null)).toEqual([]);
  });
});
