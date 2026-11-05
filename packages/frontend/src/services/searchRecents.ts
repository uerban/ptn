import type { LatLon, RecentRef } from "@pt/shared";
import type { RecentMarker, SearchSuggestion } from "./searchSuggestions.ts";
import { normalizeQuery, nameMatchScore, haversineMeters } from "./geocoder/BundledGeocoderAdapter.ts";

export const RECENT_BOOST_MAX = 0.5; // added to a 0..1 score, but clamped on merge
export const RECENT_BOOST_DECAY_DAYS = 30;
export const RECENT_DEDUP_METERS = 50; // = ADDR_AUG_DEDUP_METERS
const DAY_MS = 864e5;

/** Linear age decay: RECENT_BOOST_MAX at age 0, 0 at/after the window. */
export function recencyBoost(usedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - usedAt) / DAY_MS);
  return Math.max(0, RECENT_BOOST_MAX * (1 - ageDays / RECENT_BOOST_DECAY_DAYS));
}

/**
 * Map a RecentRef to a scored candidate, or null if it should not surface:
 *  - a LABEL-LESS mappoint (D3 — raw coords; recorded but not surfaced),
 *  - a non-empty `nq` the label/name does not match.
 * `nq` is ALREADY normalized (production passes the stream's `nq`; tests pass normalized).
 * `confidence` stays the 0..1 match component; the recency boost lives in `score` ONLY.
 * `_hint` is currently ignored (forward-compat seam for future proximity scoring).
 */
export function recentToCandidate(ref: RecentRef, nq: string, _hint: LatLon | null, now: number): RecentableSuggestion | null {
  const base = ref.base;
  if (base.kind === "mappoint" && !base.label) return null; // D3: label-less raw coords
  const label = base.kind === "stop" ? base.name : base.label;
  if (label == null) return null;
  const match = nq ? nameMatchScore(nq, label) : 0;
  if (nq && match <= 0) return null;
  const boost = recencyBoost(ref.usedAt, now);
  const marker = { usedAt: ref.usedAt, usedAsOrigin: ref.usedAsOrigin };

  if (base.kind === "stop") {
    return { kind: "stop", stopId: base.stopId, name: base.name, lat: base.lat, lon: base.lon, score: match + boost, recent: marker };
  }
  // geocoded OR labeled mappoint → geocoded-arm row with a synthetic `recent:` identity.
  return {
    kind: "geocoded", label, lat: base.lat, lon: base.lon,
    confidence: match, // 0..1 — boost NOT leaked here
    category: "recent", source: "osm",
    poiIdentity: `recent:${base.lat.toFixed(5)}|${base.lon.toFixed(5)}|${label}`,
    score: match + boost, recent: marker,
  };
}

/** Epsilon kept strictly below NAME_WEIGHTS granularity so a capped recent lands
 *  just under (never at) the sibling it must not outrank. */
const DOMINANCE_EPSILON = 1e-6;

/** The suggestion arms that carry a `recent?` marker (stop + geocoded — NOT
 *  stopGroup). Used to narrow before reading/assigning `recent`. */
type RecentableSuggestion = Extract<SearchSuggestion, { kind: "stop" | "geocoded" }>;

/** Read the `recent` marker if the arm carries one (stopGroup never does). */
function recentOf(s: SearchSuggestion): RecentMarker | undefined {
  return s.kind === "stopGroup" ? undefined : s.recent;
}

/**
 * Merge recents into live candidates so a recent that is also a live result is ONE
 * boosted, badged row (not a duplicate), and so a recent NEVER outranks a live match
 * that is STRICTLY STRONGER on pure name match (D5/strict-dominance).
 *
 * The recency boost exists precisely so a recently-used place floats ABOVE an
 * equal-or-weaker live (non-recent) sibling — that is the feature, NOT a bug. The
 * only hard rule is D5: a recent must never outrank a STRICTLY stronger live match.
 * So for each recent we take a "gate" (its pre-boost match strength) and CAP the
 * lifted score strictly below the weakest NON-recent live sibling that is STRICTLY
 * STRONGER than that gate. Equal-or-weaker non-recent siblings do NOT cap it — the
 * boosted recent is intended to outrank them. This cap applies to BOTH:
 *  - a matched recent (collapsed into an existing live row — tagged + lifted), and
 *  - an UNMATCHED recent (appended as its own row) — the earlier design clamped only
 *    the matched case, letting a standalone recent's `match + boost` leap a stronger
 *    live result. The unified cap below closes that hole.
 *
 * "Strictly stronger" compares full `score` (the cap reads `s.score` directly): a
 * sibling counts as strictly stronger only when `sibling.score > gate + DOMINANCE_EPSILON`.
 * The cap therefore guards against TOTAL score, which in the live stream already folds
 * in proximity/tap bonuses — not pure name match. The NAME_WEIGHTS tier-gap argument
 * (tiers differ by ≥0.15: exact 1.0, prefix 0.85, wordPrefix 0.7, substring 0.5) is a
 * *sufficient* drift-safety condition, not the literal rule: it explains why the
 * epsilon (1e-6) is safe — float drift from an earlier `(match + boost) - boost`
 * reconstruction (e.g. 0.85 → 0.8500000000000001) can never flip a comparison when the
 * only distinctions that matter are ≥0.15 apart. When no strictly-stronger non-recent
 * sibling exists, the full `gate + boost` lift is allowed. A matched row is never
 * demoted below its own live score.
 */
export function mergeRecentsIntoCandidates(live: SearchSuggestion[], recents: SearchSuggestion[], now: number): SearchSuggestion[] {
  const out = [...live];
  for (const r of recents) {
    const marker = recentOf(r);
    const boost = marker ? recencyBoost(marker.usedAt, now) : 0;
    // A recent may ONLY dedup against a NON-recent (live) row — never against another
    // recent. `sameRecentPlace` matches on a `recent:` synthetic identity, so without
    // the `!recentOf(s)` guard a recent could collapse into an already-appended recent;
    // it would then inherit that row's already-capped score as its `gate` and the cap
    // loop (which skips recent rows) would let its boost stack unbounded past a live
    // exact (1.0) — a D5 hole. Two distinct recents are already distinct places
    // (`listRecents` dedups by fingerprint), so they remain separate rows.
    const idx = out.findIndex((s) => !recentOf(s) && sameRecentPlace(s, r));
    // `gate` = the row's pre-boost match strength. Matched: the existing live row's
    // score. Unmatched: the recent's own match (its score minus the boost we'll re-add).
    // The reconstruction can drift (0.85 → 0.8500000000000001), but the strictly-greater
    // + epsilon comparison below only distinguishes ≥0.15 tier gaps, so drift is inert.
    const gate = idx >= 0 ? out[idx].score : r.score - boost;
    // D5 guard: cap strictly below the weakest NON-recent live candidate (other than
    // the matched row itself) that is STRICTLY STRONGER than this row's gate. Equal-or-
    // weaker non-recent siblings intentionally do NOT cap it (the float-up feature).
    let cap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length; i++) {
      if (i === idx) continue;
      const s = out[i];
      if (recentOf(s)) continue; // a recent never caps another recent
      if (s.score > gate + DOMINANCE_EPSILON) cap = Math.min(cap, s.score - DOMINANCE_EPSILON);
    }
    if (idx >= 0) {
      // sameRecentPlace only matches stop/geocoded, so out[idx] carries `recent`.
      const hit = out[idx] as RecentableSuggestion;
      const lifted = Math.max(hit.score, Math.min(hit.score + boost, cap));
      out[idx] = { ...hit, recent: marker, score: lifted };
    } else {
      out.push({ ...r, score: Math.min(r.score, cap) });
    }
  }
  return out;
}

function sameRecentPlace(a: SearchSuggestion, b: SearchSuggestion): boolean {
  if (a.kind === "stop" && b.kind === "stop") return a.stopId === b.stopId;
  if (a.kind === "geocoded" && b.kind === "geocoded" && b.poiIdentity.startsWith("recent:")) {
    const nameSim = nameMatchScore(normalizeQuery(a.label), b.label) > 0 || nameMatchScore(normalizeQuery(b.label), a.label) > 0;
    return nameSim && haversineMeters(a.lat, a.lon, b.lat, b.lon) <= RECENT_DEDUP_METERS;
  }
  return false;
}
