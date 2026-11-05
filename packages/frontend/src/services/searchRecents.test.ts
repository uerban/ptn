import { describe, it, expect } from "vitest";
import { recentToCandidate, mergeRecentsIntoCandidates, recencyBoost, RECENT_BOOST_MAX } from "./searchRecents.ts";
import type { SearchSuggestion } from "./searchSuggestions.ts";
const NOW = 1_000_000_000_000;
const stopRecent = { kind: "recent", base: { kind: "stop", stopId: "S1", name: "Stoties", lat: 54.7, lon: 25.2 }, usedAt: NOW, usedAsOrigin: false } as const;

describe("searchRecents", () => {
  it("max boost for just-used, 0 past the window", () => {
    expect(recencyBoost(NOW, NOW)).toBeCloseTo(RECENT_BOOST_MAX);
    expect(recencyBoost(NOW - 60 * 864e5, NOW)).toBe(0);
  });
  it("maps a stop recent with the recent marker", () => {
    const c = recentToCandidate(stopRecent, "sto", null, NOW)!;
    expect(c.kind).toBe("stop");
    expect(c.recent?.usedAt).toBe(NOW);
  });
  it("surfaces a labeled mappoint (stopGroup) but not a label-less one", () => {
    const labeled = { ...stopRecent, base: { kind: "mappoint", lat: 1, lon: 1, label: "Centras" } } as const;
    const bare = { ...stopRecent, base: { kind: "mappoint", lat: 1, lon: 1 } } as const;
    expect(recentToCandidate(labeled, "", null, NOW)).not.toBeNull();
    expect(recentToCandidate(bare, "", null, NOW)).toBeNull();
  });
  it("a weak recent never outranks a strictly stronger live match", () => {
    const liveExact: SearchSuggestion = { kind: "stop", stopId: "L", name: "Stoties", lat: 0, lon: 0, score: 1.0 };
    const weakRecent = recentToCandidate({ ...stopRecent, base: { kind: "geocoded", lat: 9, lon: 9, label: "Old Stoties Annex", provider: "bundled", confidence: 0.5 } } as const, "stoties", null, NOW)!;
    const merged = mergeRecentsIntoCandidates([liveExact], [weakRecent], NOW);
    const top = [...merged].sort((a, b) => b.score - a.score)[0];
    expect(top.kind === "stop" && top.stopId).toBe("L");
  });
  it("an unmatched recent floats ABOVE an EQUAL-strength live non-recent sibling (prefix tier)", () => {
    // Live non-recent prefix match (0.85) vs an UNMATCHED recent prefix match (0.85,
    // distinct identity — geocoded vs stop never dedups). The recency boost is the
    // feature: an equal-strength recent SHOULD outrank the cold live row. (At 0.85 the
    // `r.score - boost` reconstruction drifts UP to 0.8500000000000001, so the OLD
    // `>=` cap also happened not to fire — this asserts the INTENDED outcome regardless.)
    const liveStop: SearchSuggestion = { kind: "stop", stopId: "L", name: "Stoties Aikste", lat: 0, lon: 0, score: 0.85 };
    const recentPrefix = recentToCandidate({ ...stopRecent, base: { kind: "geocoded", lat: 9, lon: 9, label: "Stoties Gatve", provider: "bundled", confidence: 0.85 } } as const, "stoties", null, NOW)!;
    const merged = mergeRecentsIntoCandidates([liveStop], [recentPrefix], NOW);
    const live = merged.find((s) => s.kind === "stop" && s.stopId === "L")!;
    const rec = merged.find((s) => s.kind === "geocoded")!;
    expect(rec.score).toBeGreaterThan(live.score);
  });
  it("an unmatched recent floats ABOVE an EQUAL-strength live non-recent sibling (wordPrefix tier — exercises the predicate)", () => {
    // wordPrefix tier (0.7): here `(0.7 + boost) - boost` reconstructs to EXACTLY 0.7,
    // so the OLD `s.score >= gate` cap DID fire and clamped the recent to just below
    // the 0.7 sibling — the defect. The strictly-stronger rule leaves it uncapped.
    const liveStop: SearchSuggestion = { kind: "stop", stopId: "L", name: "Gatve Centras", lat: 0, lon: 0, score: 0.7 };
    const recentWord = recentToCandidate({ ...stopRecent, base: { kind: "geocoded", lat: 9, lon: 9, label: "Stoties Gatve", provider: "bundled", confidence: 0.7 } } as const, "gatve", null, NOW)!;
    const merged = mergeRecentsIntoCandidates([liveStop], [recentWord], NOW);
    const live = merged.find((s) => s.kind === "stop" && s.stopId === "L")!;
    const rec = merged.find((s) => s.kind === "geocoded")!;
    expect(rec.score).toBeGreaterThan(live.score);
  });
  it("an unmatched recent stays STRICTLY BELOW a strictly-stronger live row", () => {
    // Live exact (1.0) vs unmatched recent prefix (0.85): D5 — the recent must never
    // outrank the strictly stronger live match.
    const liveExact: SearchSuggestion = { kind: "stop", stopId: "L", name: "Stoties", lat: 0, lon: 0, score: 1.0 };
    const recentPrefix = recentToCandidate({ ...stopRecent, base: { kind: "geocoded", lat: 9, lon: 9, label: "Stoties Gatve", provider: "bundled", confidence: 0.85 } } as const, "stoties", null, NOW)!;
    const merged = mergeRecentsIntoCandidates([liveExact], [recentPrefix], NOW);
    const rec = merged.find((s) => s.kind === "geocoded")!;
    expect(rec.score).toBeLessThan(1.0);
  });
  it("two near-duplicate recents never stack a boost past a strictly-stronger live exact (D5)", () => {
    // Two distinct geocoded recents for near-identical places: same label, within
    // RECENT_DEDUP_METERS (50 m) of each other → `sameRecentPlace` matches one against
    // the other. With the old whole-array `findIndex`, the SECOND recent dedups against
    // the FIRST (already-appended) recent, inherits its capped score as `gate`, and the
    // cap loop (which skips recent rows) lets the boost stack unbounded → ~1.5, past the
    // live exact (1.0). The `!recentOf(s)` guard forces a recent to dedup only against a
    // live row, so both recents stay capped strictly below the 1.0 live exact.
    const liveExact: SearchSuggestion = { kind: "stop", stopId: "L", name: "Stoties", lat: 0, lon: 0, score: 1.0 };
    const recentA = recentToCandidate({ ...stopRecent, base: { kind: "geocoded", lat: 54.7000, lon: 25.2000, label: "Stoties Gatve", provider: "bundled", confidence: 0.85 } } as const, "stoties", null, NOW)!;
    // ~25 m east of A (≈0.0004° lon at 54.7°N) — within the 50 m dedup radius, same label.
    const recentB = recentToCandidate({ ...stopRecent, base: { kind: "geocoded", lat: 54.7000, lon: 25.2004, label: "Stoties Gatve", provider: "bundled", confidence: 0.85 } } as const, "stoties", null, NOW)!;
    const merged = mergeRecentsIntoCandidates([liveExact], [recentA, recentB], NOW);
    const recents = merged.filter((s) => s.kind === "geocoded");
    expect(recents).toHaveLength(2); // two distinct places stay separate rows
    for (const rec of recents) expect(rec.score).toBeLessThan(1.0);
  });
  it("tags a live stop match instead of duplicating", () => {
    const live: SearchSuggestion[] = [{ kind: "stop", stopId: "S1", name: "Stoties", lat: 54.7, lon: 25.2, score: 0.6 }];
    const merged = mergeRecentsIntoCandidates(live, [recentToCandidate(stopRecent, "sto", null, NOW)!], NOW);
    expect(merged).toHaveLength(1);
    const top = merged[0];
    expect(top.kind !== "stopGroup" && top.recent).toBeTruthy();
    expect(top.score).toBeGreaterThan(0.6);
  });
});
