import { describe, expect, it } from "vitest";
import { LATEST_WHATS_NEW_ID, unseenWhatsNewEntries, WHATS_NEW_ENTRIES } from "./whatsNew.ts";

describe("What's new entries", () => {
  it("ships the service alerts entry with a positive, unique id", () => {
    const ids = WHATS_NEW_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
    expect(WHATS_NEW_ENTRIES.some((entry) => entry.topic === "service-alerts")).toBe(true);
    expect(LATEST_WHATS_NEW_ID).toBe(Math.max(...ids));
  });

  it("shows every entry above the seen id, oldest first", () => {
    const entries = [
      { id: 3, topic: "service-alerts" as const },
      { id: 1, topic: "service-alerts" as const },
      { id: 2, topic: "service-alerts" as const },
    ];
    expect(unseenWhatsNewEntries({ seenWhatsNew: 1 }, entries).map((e) => e.id)).toEqual([2, 3]);
    expect(unseenWhatsNewEntries({ seenWhatsNew: 3 }, entries)).toEqual([]);
  });

  it("existing installations have the alerts entry unseen; setup marks everything seen", () => {
    expect(unseenWhatsNewEntries({ seenWhatsNew: 0 }).map((e) => e.topic)).toContain("service-alerts");
    expect(unseenWhatsNewEntries({ seenWhatsNew: LATEST_WHATS_NEW_ID })).toEqual([]);
    expect(unseenWhatsNewEntries(null)).toEqual([]);
  });
});
