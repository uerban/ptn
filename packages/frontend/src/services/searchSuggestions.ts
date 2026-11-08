import { captureCityData } from "./cityData.ts";
import { useCityStore } from "../stores/cityStore.ts";
import Dexie from "dexie";
import { isPoiCategoryEnabled } from "./poiCategoryPreferences.ts";
import type { Stop, LatLon, GeocoderCandidate, PoiFetchMode } from "@pt/shared";
import { REMOTE_STOP_SEARCH_MIN_CHARS } from "@pt/shared/constants";
import { db, type PoiIndexRecord } from "../db/index.ts";
import {
  normalizeQuery,
  scoreCandidate,
  haversineMeters,
  flatAliases,
  deduplicateRecords,
  nameMatchScore,
} from "./geocoder/BundledGeocoderAdapter.ts";
import { poiCityIds } from "./poiCityMapping.ts";
import { api } from "./api.ts";
import { reportError } from "./errorReporter.ts";
import type { SearchProvider } from "../stores/settingsStore.ts";
// Self-import so the engine's own per-record scoring goes through the module's
// live export binding. This lets AC-17 (vi.spyOn(mod, "scorePoiRecord")) observe
// the engine's internal calls — a direct local call would bypass the spy.
import * as self from "./searchSuggestions.ts";
import { geocoderRegistry } from "./geocoder/instance.ts";
import {
  localAddressCandidates,
  type AddressSearchCandidate,
} from "./geocoder/AddressSearchGeocoderAdapter.ts";
import { listRecents } from "./recents.ts";
import { recentToCandidate, mergeRecentsIntoCandidates } from "./searchRecents.ts";
import { loadStopUsage } from "./stopUsage.ts";
import { isPoiRecordInCurrentTileGeneration } from "./tileCache.ts";

// Module-scoped, setter-injected mode accessor (mirrors the registry's
// setActiveModeAccessor idiom from #278). Default = "never server-side" so every
// existing caller/test keeps today's local-poiIndex behaviour with zero wiring.
// Typed against PoiFetchMode (a @pt/shared TYPE-only import — erased by tsc, no
// runtime edge) so the accessor cannot silently carry an off-union value. This
// file MUST stay a leaf — it imports neither the resolver module nor the resolver
// symbol (AC-15); the injected accessor is the ONLY mode channel. (Deliberately
// phrased WITHOUT the resolver's literal token so a future blunt substring guard
// does not false-positive on this comment.)
let resolveModeForSearch: (cityId: string) => PoiFetchMode = () => "eager-bundle";

/**
 * Inject the active-mode resolver. Called once from bootPoi.ts at boot (alongside
 * geocoderRegistry.setActiveModeAccessor over the SAME resolver), so the engine stays a leaf
 * and tests can stub it directly.
 */
export function setSearchModeAccessor(fn: (cityId: string) => PoiFetchMode): void {
  resolveModeForSearch = fn;
}

/** Test-only reset to the default no-op accessor. */
export function __resetSearchModeAccessorForTests(): void {
  resolveModeForSearch = () => "eager-bundle";
}

/** Recents marker carried by a suggestion that originated from (or matched) a
 *  recorded recent place. Drives the "Recent" badge in the suggestion row and the
 *  age-decay recency boost in searchRecents.ts. Lives on the `stop` and `geocoded`
 *  arms only (a stopGroup is never a recent — a stopGroup recent pick is recorded
 *  as a labeled mappoint → surfaced via the geocoded arm). */
export type RecentMarker = { usedAt: number; usedAsOrigin: boolean };

export type SearchSuggestion =
  | {
      kind: "stop";
      stopId: string;
      name: string;
      lat: number;
      lon: number;
      score: number;
      recent?: RecentMarker;
    }
  | {
      kind: "stopGroup";
      groupId: string;
      name: string;
      lat: number;
      lon: number;
      stopCount: number;
      /** Member stop_ids — threaded to the stopGroup endpoint so routing can
       *  seed every sibling (resolveToEntryStops / the orchestrator force-in). */
      stopIds: string[];
      score: number;
    }
  | {
      kind: "geocoded";
      label: string;
      aliases?: PoiIndexRecord["aliases"];
      address?: PoiIndexRecord["address"];
      lat: number;
      lon: number;
      confidence: number;
      category: string;
      source: "curated" | "osm";
      /**
 * Stable POI identity = osmId ?? id, mirrored from the PoiIndexRecord this suggestion was built
 * from. Used by the monotonic top-hit pin AND it is the SAME key deduplicateRecords uses
 * (bundle wins) so a tile→bundle replacement keeps the pin.
 */
      poiIdentity: string;
      /**
 * Provenance mirrored from the PoiIndexRecord, used to break a score-TIE in the stream's
 * per-identity dedup the same way deduplicateRecords does: a bundle row (undefined/"bundle")
 * wins over a "tile" row (tile→bundle replacement).
 */
      loadSource?: "bundle" | "tile";
      score: number;
      recent?: RecentMarker;
    };

/** The geocoded arm of SearchSuggestion. Server geocoder rows are ALWAYS geocoded
 *  (built by candidateToSuggestion), so the dedup seam + augment closure type
 *  against this — reading .label/.lat/.lon needs the narrowed arm (a bare
 *  SearchSuggestion would not type-check; stop/stopGroup carry `name`, not `label`). */
export type GeocodedSuggestion = Extract<SearchSuggestion, { kind: "geocoded" }>;

/**
 * Map a server geocoder candidate into a geocoded SearchSuggestion. GeocoderCandidate carries
 * no osmId/category/source, so the mapper synthesises: - label/lat/lon: 1:1 from the candidate.
 * - confidence + score: BOTH = candidate.confidence (the adapter already normalised importance
 * into [0,1]); score is the SAME value so server hits rank against stops on the existing 0..1
 * scale. - category: "address" (stable non-empty sentinel; poiCategoryIcon falls back to a
 * default glyph for unknown categories). - source: "osm" (SearchSuggestion.source literal — NOT
 * a privacy tier). - poiIdentity: a DETERMINISTIC `srv:` namespaced identity from
 * label+lat+lon+index. Within the geocoded kind, the `srv:` prefix keeps a server candidate
 * distinct from a local `poi:` row (which has no `srv:` prefix); a same-named STOP never
 * collides because finalize prefixes by KIND (`stop:` vs `poi:`) — see AC-1c. `idx` keeps two
 * candidates sharing label+coords distinct WITHIN one result set — sound only because the
 * server candidates appear in a SINGLE BATCH in one emit (server-side single-emit AND
 * augmentation's one-batch merge both satisfy this). - loadSource: OMITTED (a server result is
 * neither a tile nor a bundle row).
 */
export function candidateToSuggestion(c: GeocoderCandidate, idx: number): GeocodedSuggestion {
  const conf = Number.isFinite(c.confidence) ? c.confidence : 0.5;
  // Defensive finite-coord guard: a non-finite lat/lon would make .toFixed(5)
  // emit "NaN" — both in the identity AND in the suggestion's own lat/lon, which
  // flow into map-pin placement and route origin/dest when the user selects the
  // result. The adapter's contract is finite coords; this guards a contract
  // violation. The guarded values are used for BOTH the identity and the
  // suggestion fields (no raw/guarded asymmetry — a raw NaN must never ship).
  const idLat = Number.isFinite(c.lat) ? c.lat : 0;
  const idLon = Number.isFinite(c.lon) ? c.lon : 0;
  return {
    kind: "geocoded",
    label: c.label,
    lat: idLat,
    lon: idLon,
    confidence: conf,
    category: "address",
    source: "osm",
    poiIdentity: `srv:${c.label}|${idLat.toFixed(5)}|${idLon.toFixed(5)}|${idx}`,
    score: conf,
  };
}

export function addressCandidateToSuggestion(
  c: AddressSearchCandidate,
  cityId: string,
): GeocodedSuggestion {
  const conf = Number.isFinite(c.confidence) ? c.confidence : 0.5;
  const idLat = Number.isFinite(c.lat) ? c.lat : 0;
  const idLon = Number.isFinite(c.lon) ? c.lon : 0;
  return {
    kind: "geocoded",
    label: c.label,
    lat: idLat,
    lon: idLon,
    confidence: conf,
    category: "address",
    source: "osm",
    poiIdentity: `addr:${cityId}:${c.rowId}`,
    loadSource: "bundle",
    score: conf,
  };
}

/**
 * Proximity+name dedup of mapped server suggestions vs the already-shown LOCAL POI rows. Pure —
 * exported so tests assert drop/keep without driving the stream. A server row is dropped iff
 * some local POI row is BOTH name-similar AND co-located (≤ ADDR_AUG_DEDUP_METERS). Compares
 * against local POI ONLY: rows whose kind === "geocoded" AND whose RAW poiIdentity does NOT
 * start with "srv:" (stops/groups and other server rows are excluded).

 *
 *  Compile-safety (must-fix): serverSuggestions is GeocodedSuggestion[], NOT
 *  SearchSuggestion[] — .label/.lat/.lon are read unconditionally on `srv` and do
 *  not exist on the stop/stopGroup arms. The one caller (augment) maps via
 *  candidateToSuggestion, which now returns GeocodedSuggestion, so the narrowed
 *  type is sound at the call site. localBestN stays SearchSuggestion[] (mixed
 *  kinds) and is narrowed inside via the `s is GeocodedSuggestion` guard. */
export function dedupServerAgainstLocal(
  serverSuggestions: GeocodedSuggestion[],
  localBestN: SearchSuggestion[],
): GeocodedSuggestion[] {
  const localPois = localBestN.filter(
    (s): s is GeocodedSuggestion =>
      s.kind === "geocoded" && !s.poiIdentity.startsWith("srv:"),
  );
  return serverSuggestions.filter((srv) => {
    const isDuplicate = localPois.some((local) => {
      // Name-similarity is "the local POI's name appears as a token-prefix/substring
      // of the (longer) server label" — the realistic case is a short curated local
      // name (e.g. "Stoties") duplicated by a long nominatim display_name (e.g.
      // "Stoties g. 10, Vilnius, Lithuania"). So the local name is the NEEDLE
      // (normalizeQuery(local.label)) and the server label is the RAW HAYSTACK
      // (nameMatchScore normalizes arg 2 internally — do NOT pre-normalize it).
      // (AC-A17 "drop the duplicate" / AC-A20 "realistic long label": the spec's
      // arg order is inverted relative to this intent — a server-label needle
      // never matches a short local name — so the direction is corrected here to
      // satisfy the plan's named dedup test; see Step 4(c) deviation note.)
      const nameSimilar = nameMatchScore(normalizeQuery(local.label), srv.label) > 0;
      if (!nameSimilar) return false;
      const meters = haversineMeters(srv.lat, srv.lon, local.lat, local.lon);
      return meters <= ADDR_AUG_DEDUP_METERS;
    });
    return !isDuplicate;
  });
}

/** Server-side POI search: consult the self-hosted geocoder via the registry and
 *  map candidates → geocoded suggestions. NO db.poiIndex scan (residency). The
 *  registry (#278) gates the local + third-party tiers OUT under server-side, so
 *  this returns ONLY self-hosted candidates (or [] when the tier is unavailable /
 *  down — the registry swallows a provider-failed to [] after emitting the status
 * the GeocoderStatusChip renders; ). AbortError propagates so Search.tsx's
 *  catch drops the stale result; ANY other rejection degrades to [] so a non-abort
 * throw cannot take down the stops leg via the Promise.all short-circuit. */
export async function searchServerSidePoi(
  query: string,
  hint: LatLon | null,
  signal: AbortSignal,
): Promise<SearchSuggestion[]> {
  try {
    const candidates = await geocoderRegistry.forward(query, hint, signal);
    return candidates.map((c, i) => candidateToSuggestion(c, i));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return [];
  }
}

/**
 * Signature of the prefetch driver — a FIRST-CLASS, PUBLIC seam (NOT a magic `__`-prefixed
 * field). Production builds one from runViewportPrefetch; tests pass a fake. When present, the
 * stream invokes it and re-emits per `onTileLanded`; when absent, the stream emits once and
 * resolves (eager / one-shot path). The driver calls `onTileLanded(landedRows)` per coalesced
 * idle tick, passing the POI rows that landed (for the bounded merge-into-best-N); callers with
 * no rows may call `onTileLanded()`.
 */
export type SearchPrefetchDriver = (
  onTileLanded: (landedRows?: PoiIndexRecord[]) => void | Promise<void>,
  signal: AbortSignal,
) => Promise<void>;

export interface SearchStreamCallbacks {
  /** Called 1..N times. `partial` is the FULL current best-N list (not a delta),
   *  sorted desc by score, sliced to MAX_RESULTS. `done` is true on the final
   *  emit. Monotonic invariant: partial[0] never changes to a LOWER-scoring
   *  suggestion across emits for the same query. */
  onResults: (partial: SearchSuggestion[], meta: { done: boolean; emitSeq: number }) => void;
  /** Optional prefetch driver (public seam). When present, the stream re-emits
   *  as the driver lands tiles; when absent, single-emit one-shot/eager path. */
  driver?: SearchPrefetchDriver;
  /**
 * Optional perceived-stability gate. When it returns true (the suggestions listbox is focused,
 * or within a short window after the last keystroke), the stream suppresses REORDERING of rows
 * 2..N below the pinned top hit on a re-emit — newly-landed rows may APPEND at the tail but the
 * already-displayed rows 2..N keep their prior relative order, so in-flight keyboard navigation
 * (Search.tsx reads activeElement position from the live DOM) does not mis-tap/focus-jump.
 * Absent ⇒ always re-sort (one-shot/eager, or tests not exercising focus).
 */
  isListboxFocused?: () => boolean;
}

/** Results the engine keeps per query. The list shows SUGGESTION_PAGE_SIZE at a
 *  time behind "Show more": a city-name query such as "Tbilisi" matches dozens
 *  of places, and the 15-row cap used to hide real destinations. */
const MAX_RESULTS = 60;
export const SUGGESTION_PAGE_SIZE = 15;
const STOP_BASE_SCORE = 0.6;
// Must stay below the substring tier (0.5) in NAME_WEIGHTS so a no-match
// fallback can never outrank a tiered match.
const STOP_FALLBACK_WEIGHT = 0.4;
const GROUP_BONUS = 0.1;
const LOCAL_STOP_LIMIT = 25;

/** Exported copy of MAX_RESULTS so 's slice-invariant test asserts against the
 *  symbol, not a literal. Same value; do not diverge. */
export const MAX_RESULTS_EXPORTED = MAX_RESULTS;

// --- Address-augmentation tuning constants (exported so tests assert against the symbols, never
// magic literals). ---
/** Rollout / kill-switch. Default ON once shipped; env-backed VITE_PT_ADDR_AUG
 * ("0"/"false" disables). Short-circuits the augmentation arming check. */
export const ADDR_AUG_ENABLED: boolean =
  import.meta.env.VITE_PT_ADDR_AUG !== "0" && import.meta.env.VITE_PT_ADDR_AUG !== "false";
/** Shape prefilter: minimum NORMALIZED query length before any augmentation
 *  egress. Independent of REMOTE_STOP_SEARCH_MIN_CHARS. */
export const ADDR_AUG_MIN_QUERY_LEN = 4;
/** Sparsity trigger: augment only when settled LOCAL-POI rows < this. MUST stay
 *  < MAX_RESULTS so the finalize slice can never hide a sparse local-POI set. */
export const ADDR_AUG_SPARSE_THRESHOLD = 5;
/** Proximity dedup radius (m) between a server address and a like-named local POI. */
export const ADDR_AUG_DEDUP_METERS = 50;
/**
 * Per-augment fetch timeout (ms). The SelfHostedGeocoderAdapter's doFetch has NO timeout of its
 * own (verified — bare `fetch(url, { signal })`), so a slow (cold nominatim) query would strand
 * a non-terminal "loading" list even though the local result is already complete. augment()
 * races forwardSelfHosted against this and degrades to [] on timeout (ships the local set,
 * done=true).
 */
export const ADDR_AUG_TIMEOUT_MS = 3000;

// Compile-time-adjacent invariant guard (also asserted by a unit test): a sparse
// threshold at or above the slice cap could be masked by the MAX_RESULTS slice.
if (ADDR_AUG_SPARSE_THRESHOLD >= MAX_RESULTS) {
  throw new Error("ADDR_AUG_SPARSE_THRESHOLD must be < MAX_RESULTS");
}

// Second injected accessor: "does a self-hosted geocoder resolve for this city?" Wired from
// bootPoi.ts over hasServerSideGeocoder, mirroring setSearchModeAccessor. This file stays a leaf —
// it imports neither the resolver module nor registerSelfHosted (either would risk the instance.ts
// cycle). Default = "no geocoder present" so every existing caller/test keeps today's behaviour.
let geocoderPresentForCity: (cityId: string) => boolean = () => false;

/** Inject the geocoder-present capability read. Called once from bootPoi.ts. */
export function setGeocoderPresentAccessor(fn: (cityId: string) => boolean): void {
  geocoderPresentForCity = fn;
}

/** Test-only reset to the default no-op accessor. */
export function __resetGeocoderPresentAccessorForTests(): void {
  geocoderPresentForCity = () => false;
}

// Third injected accessor: "may this device egress to a third party?" Wired from
// bootPoi.ts over the `external.stop-search` flow, alongside the two mode accessors above —
// same leaf-module reason (importing privacyStore here would pull the store graph
// into a leaf that tests instantiate directly).
//
// Default is DENY, matching the other two accessors' fail-safe defaults ("never
// server-side", "no geocoder present"). An unwired accessor therefore degrades
// remote stop search to the local scan instead of silently egressing — the right
// direction for a privacy gate to fail in.
let thirdPartyEgressAllowed: () => boolean = () => false;

/** Inject the third-party egress gate read. Called once from bootPoi.ts. */
export function setThirdPartyEgressAccessor(fn: () => boolean): void {
  thirdPartyEgressAllowed = fn;
}

/** Test-only reset to the deny-by-default accessor. */
export function __resetThirdPartyEgressAccessorForTests(): void {
  thirdPartyEgressAllowed = () => false;
}

/** Test-only read-through of the injected accessor. */
export function getThirdPartyEgressAllowedForTests(): boolean {
  return thirdPartyEgressAllowed();
}

/** Test-only read-through of the injected accessor (lets assert the wiring). */
export function getGeocoderPresentForTests(cityId: string): boolean {
  return geocoderPresentForCity(cityId);
}

/** Read the user's recents (tier-aware, module-cached in recents.ts — safe per
 *  keystroke) and map each to a scored, `recent`-marked candidate, dropping rows
 *  that don't match `nq` (empty `nq` keeps all — the empty-query Recent group) or
 *  are label-less raw coords. The mapped candidates flow through the SAME
 *  finalize() dedup/sort as live results. `nq` is already normalized. */
async function recentCandidates(nq: string, hint: LatLon | null): Promise<SearchSuggestion[]> {
  const now = Date.now();
  const out: SearchSuggestion[] = [];
  for (const ref of await listRecents()) {
    const c = recentToCandidate(ref, nq, hint, now);
    if (c) out.push(c);
  }
  return out;
}

export async function searchSuggestionsStream(
  query: string,
  cityId: string,
  hint: LatLon | null,
  signal: AbortSignal,
  provider: SearchProvider,
  cb: SearchStreamCallbacks,
): Promise<void> {
  const nq = normalizeQuery(query);
  if (!nq) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const recents = await recentCandidates("", hint);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // recents are fingerprint-deduped upstream by listRecents, so no finalize() identity-dedup is needed here.
    cb.onResults(recents.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS), { done: true, emitSeq: 0 });
    return;
  }

  // Server-side is a one-shot source with no tiles. Even if a caller erroneously
  // passes a driver, treat it as driver === undefined so no re-emit loop spins
  // over a city with no tiles ( / AC-16).
  const searchMode = resolveModeForSearch(cityId);
  const serverSideMode = searchMode === "server-side";
  const lazyTileMode = searchMode === "lazy-tile";
  const effectiveDriver = serverSideMode ? undefined : cb.driver;
  let emitSeq = 0;
  // Pin the previous top-hit IDENTITY (osmId ?? id via poiIdentity), not its score.
  let pinnedTopIdentity: string | null = null;
  // Retained sorted best-N (geocoded + stop/group) from the prior emit. Re-emits
  // merge newly-landed scored rows into THIS, not a full corpus re-score.
  let bestN: SearchSuggestion[] = [];
  // Pre-slice settled local-POI count, stashed by finalize() before its
  // MAX_RESULTS truncation. The augmentation sparsity GATE reads THIS (not a count
  // over the sliced bestN) so a stop-heavy city whose local-POI are pushed below
  // the slice is not mis-read as sparse (must-fix — egress correctness; AC-A5b).
  let lastPreSliceLocalPoiCount = 0;

  // Apply dedup-by-identity (bundle wins), monotonic pin, and slice to a scored
  // candidate set. Pure over its input array — no DB read. `preserveTailOrder`
  // is true on a re-emit while the listbox is focused (perceived-stability rule).
  function finalize(candidates: SearchSuggestion[], preserveTailOrder: boolean): SearchSuggestion[] {
    // Dedup by suggestionIdentity, keeping the higher-scoring record per identity
    // (and, for equal scores from a tile vs bundle, the bundle — mirrors
    // deduplicateRecords; geocoded identity == poiIdentity == the dedup key).
    const byId = new Map<string, SearchSuggestion>();
    for (const s of candidates) {
      const k = suggestionIdentity(s);
      const prev = byId.get(k);
      // Higher score wins; on an EXACT score tie a bundle row beats a tile row
      // (mirrors deduplicateRecords — the bundle is the canonical source). Only
      // geocoded suggestions carry loadSource; stops/groups never tie on identity.
      if (!prev || s.score > prev.score || (s.score === prev.score && isTileSuggestion(prev) && !isTileSuggestion(s))) {
        byId.set(k, s);
      }
    }
    let merged = [...byId.values()];
    merged.sort((a, b) => b.score - a.score || (suggestionIdentity(a) < suggestionIdentity(b) ? -1 : 1));
    if (pinnedTopIdentity !== null && merged.length > 0) {
      const pinnedIdx = merged.findIndex((s) => suggestionIdentity(s) === pinnedTopIdentity);
      // Keep the pin at index 0 unless a STRICTLY higher-scoring DIFFERENT POI
      // exists at index 0. A same-identity rescore never demotes below a
      // lower-scoring item; an equal-score tie is stable by id (the sort above).
      if (pinnedIdx > 0 && merged[pinnedIdx].score >= merged[0].score) {
        const [pinned] = merged.splice(pinnedIdx, 1);
        merged.unshift(pinned);
      }
    }
    if (preserveTailOrder) {
      // Perceived-stability: keep partial[0] (the pinned/top hit) at the head, but preserve the
      // PRIOR relative order of the already-displayed rows 2..N (the ones still present), appending
      // only genuinely-new rows at the tail. This stops rows shuffling under an in-flight keyboard
      // cursor.
      const head = merged.length > 0 ? [merged[0]] : [];
      const rest = new Map(merged.slice(1).map((s) => [suggestionIdentity(s), s]));
      const priorTail = bestN.slice(1)
        .map((s) => rest.get(suggestionIdentity(s)))
        .filter((s): s is SearchSuggestion => s !== undefined);
      const priorTailIds = new Set(priorTail.map(suggestionIdentity));
      const appended = merged.slice(1).filter((s) => !priorTailIds.has(suggestionIdentity(s)));
      merged = [...head, ...priorTail, ...appended];
    }
    // Count local-POI (geocoded, non-srv:) in the FULL deduped set BEFORE slicing,
    // for the augmentation sparsity gate (must-fix — egress correctness). `merged`
    // here is the post-dedup/pin/tail-order union; the slice below is what bestN
    // exposes, but the gate must see the pre-slice truth.
    lastPreSliceLocalPoiCount = merged.filter(
      (s) => s.kind === "geocoded" && !s.poiIdentity.startsWith("srv:"),
    ).length;
    const out = merged.slice(0, MAX_RESULTS);
    if (out.length > 0) pinnedTopIdentity = suggestionIdentity(out[0]);
    return out;
  }

  // FULL initial scan (first emit only): score the whole already-loaded union.
  // Initial emit never preserves tail order (there is no prior tail).
  async function computeInitial(): Promise<SearchSuggestion[]> {
    // serverSide is read via the injected accessor (leaf-module invariant, ).
    // Hint vs nq asymmetry is intentional: searchPoi gets the NORMALIZED query (nq)
    // for its local token scan; searchServerSidePoi gets the RAW query (the
    // geocoder normalizes server-side — pre-normalizing would corrupt diacritics).
    // searchStopsWithGroups is called via self.* so AC-4a can spy its 5-tuple.
    const [stopResults, poiResults, addressResults] = await Promise.all([
      self.searchStopsWithGroups(query, nq, hint, signal, provider),  // UNCHANGED args; self.* for spy
      serverSideMode
        ? searchServerSidePoi(query, hint, signal)                    // registry.forward → geocoded
        : searchPoi(nq, cityId, hint, signal, lazyTileMode),
      serverSideMode
        ? Promise.resolve([])
        : self.searchLocalAddresses(query, cityId, hint, signal),
    ]);
    const recents = await recentCandidates(nq, hint);
    const live = [...stopResults, ...poiResults, ...addressResults];
    return finalize(mergeRecentsIntoCandidates(live, recents, Date.now()), false);
  }

  // BOUNDED re-scan: score ONLY the newly-landed POI rows, merge into bestN.
  // Re-emits honor the perceived-stability gate while the listbox is focused.
  function mergeLanded(landedRows: PoiIndexRecord[]): SearchSuggestion[] {
    const scored: SearchSuggestion[] = [];
    for (const rec of landedRows) {
      if (
        lazyTileMode &&
        !isPoiRecordInCurrentTileGeneration(rec)
      ) {
        continue;
      }
      const s = self.scorePoiRecord(rec, nq, hint); // returns a geocoded suggestion or null
      if (s) scored.push(s);
    }
    // recents already live inside bestN from computeInitial; re-merge so a NEW landed
    // live POI that matches a recent collapses (proximity/name) rather than duplicating.
    // `isRecentRow` narrows past the stopGroup arm (which carries no `recent`).
    const isRecentRow = (s: SearchSuggestion): boolean => s.kind !== "stopGroup" && s.recent !== undefined;
    const recents = bestN.filter(isRecentRow);
    const fresh = mergeRecentsIntoCandidates([...bestN.filter((s) => !isRecentRow(s)), ...scored], recents, Date.now());
    return finalize(fresh, cb.isListboxFocused?.() === true);
  }

  function emit(partial: SearchSuggestion[], done: boolean): void {
    bestN = partial;
    cb.onResults(partial, { done, emitSeq: emitSeq++ });
  }

  // Address augmentation arming: a LOCAL mode + geocoder present + the rollout gate on + a
  // long-enough normalized query. The sparsity trigger is checked LATER, against the SETTLED
  // PRE-SLICE local-POI count (after the driver loop for lazy-tile, or the single pass for eager).
  // serverSideMode is computed above.
  const augmentArmed =
    ADDR_AUG_ENABLED &&
    !serverSideMode &&
    nq.length >= ADDR_AUG_MIN_QUERY_LEN &&
    geocoderPresentForCity(cityId);

  // The augmentation seam: pre-slice sparsity gate + timeout-bounded self-hosted
  // fetch + map (one batch, stable idx) + dedup vs the shown local POI (bestN,
  // settled by the prior emit). Resolves to the deduped server suggestions, or []
  // when the gate fails / the server is empty / a timeout fires. Awaited ONCE per
  // invocation after the local set settles. A genuine outer abort propagates as a
  // thrown AbortError (forwardSelfHosted re-throws); any non-abort failure already
  // degraded to [] inside the registry.
  async function augment(): Promise<GeocodedSuggestion[]> {
    if (!augmentArmed) return [];
    // Sparsity gate over the PRE-SLICE settled local-POI count (must-fix — egress
    // correctness; NOT a count over the sliced bestN). lastPreSliceLocalPoiCount was
    // stashed by the last finalize (computeInitial for eager; the final mergeLanded
    // for lazy-tile) — see AC-A5b.
    if (lastPreSliceLocalPoiCount >= ADDR_AUG_SPARSE_THRESHOLD) return [];
    // Egress-accounting breadcrumb: logged BEFORE the fetch (and before the adapter's isAvailable
    // check) so "queried" == "the gate decided to query this city's endpoint".
    console.info("[poiSync] augmentation: queried self-hosted", {
      cityId, queryLen: nq.length, localPoiCount: lastPreSliceLocalPoiCount,
    });
    // Race forwardSelfHosted against ADDR_AUG_TIMEOUT_MS so a slow geocoder cannot
    // strand a non-terminal list (the adapter has no fetch timeout of its own —
    // verified). The timeout AbortController is LINKED to the per-invocation signal:
    // an outer abort OR the timeout aborts the fetch. On TIMEOUT we degrade to []
    // (ship the local set, done=true); on an OUTER abort we re-throw the AbortError.
    const augCtrl = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => augCtrl.abort();
    signal.addEventListener("abort", onOuterAbort);
    const timer = setTimeout(() => { timedOut = true; augCtrl.abort(); }, ADDR_AUG_TIMEOUT_MS);
    let candidates: GeocoderCandidate[];
    try {
      // RAW query to the geocoder (diacritic-preserving; it normalizes server-side).
      candidates = await geocoderRegistry.forwardSelfHosted(query, hint, augCtrl.signal);
    } catch (err) {
      if (timedOut && !signal.aborted) return []; // augment-only timeout → ship local set
      throw err; // genuine outer abort re-thrown; the registry degraded other errors to []
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }
    if (candidates.length === 0) return [];
    // Hit-count breadcrumb (absent on an empty result; spec AC-A26).
    console.info("[poiSync] augmentation: candidates", { cityId, candidates: candidates.length });
    const mapped = candidates.map((c, i) => candidateToSuggestion(c, i)); // one batch, stable idx
    return dedupServerAgainstLocal(mapped, bestN); // dedup vs the SHOWN (sliced) local POI
  }

  // First emit from already-loaded data.
  const first = await computeInitial();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const noDriver = effectiveDriver === undefined;

  if (noDriver) {
    // Eager / server-side path: no tile re-emit loop. computeInitial()'s finalize
    // already settled lastPreSliceLocalPoiCount, so decide up front whether
    // augmentation will fire. When it will NOT (rich local set, or not armed), the
    // first emit is terminal — a SINGLE done=true frame, no redundant identical
    // re-emit (Should-fix). serverSide is inert here (augmentArmed is false under
    // server-side). Uses the PRE-SLICE count (must-fix; AC-A5b/A12).
    const willAugment = augmentArmed && lastPreSliceLocalPoiCount < ADDR_AUG_SPARSE_THRESHOLD;
    emit(first, !willAugment);
    if (!willAugment) return;
    // Fold the augmentation emit in INSTEAD OF the early return. Eager RE-THROWS a mid-augment
    // AbortError (faithful to today's eager early-return shape + the augment-rethrow contract;
    // AC-A24 eager sub-case).
    const added = await augment();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // augment() can still return [] (server empty, all deduped, or a timeout); close
    // with done=true either way.
    const next = added.length > 0
      ? finalize([...bestN, ...added], cb.isListboxFocused?.() === true)
      : bestN;
    emit(next, true);
    return;
  }

  // lazy-tile: first emit is non-terminal (the tile loop and/or augmentation may
  // still re-emit). Today's first-emit done semantics are preserved for the driver
  // path (it was already done=false here).
  emit(first, false);

  // Re-emit as tiles land. The driver coalesces to at most one onTileLanded per
  // idle tick. Each onTileLanded merges the landed rows into the bounded best-N.
  await effectiveDriver(async (landedRows: PoiIndexRecord[] = []) => {
    if (signal.aborted) return;
    const next = mergeLanded(landedRows);
    if (signal.aborted) return;
    emit(next, false);
  }, signal);

  if (signal.aborted) return; // abort after >=1 emit resolves (no reject)

  // lazy-tile: the driver's final mergeLanded settled lastPreSliceLocalPoiCount;
  // augment() reads it (gate) + bestN (dedup), then folds into the FINAL emit (no
  // separate terminal frame). A mid-augment abort is CAUGHT and converted to a quiet
  // return — preserving the pre-existing lazy "abort-after-emit is a quiet return,
  // no reject" contract (AC-A24 lazy sub-case). Eager re-throws; lazy resolves quietly.
  let added: GeocodedSuggestion[];
  try {
    added = await augment();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return; // quiet, no reject
    throw e;
  }
  if (signal.aborted) return;
  const merged = added.length > 0
    ? finalize([...bestN, ...added], cb.isListboxFocused?.() === true)
    : bestN;
  emit(merged, true);
}

export async function searchSuggestions(
  query: string,
  cityId: string,
  hint: LatLon | null,
  signal: AbortSignal,
  provider: SearchProvider,
): Promise<SearchSuggestion[]> {
  let last: SearchSuggestion[] = [];
  await searchSuggestionsStream(query, cityId, hint, signal, provider, {
    onResults: (partial) => { last = partial; },
  });
  return last;
}

/**
 * Pin/dedup identity. Geocoded suggestions key on `poiIdentity` (= osmId ?? id, threaded on in
 * Step 0) — the SAME key deduplicateRecords uses, so a tile→ bundle replacement of the same POI
 * keeps the pin (bundle wins, stays pinned). Stops/groups use their own id.
 */
function suggestionIdentity(s: SearchSuggestion): string {
  if (s.kind === "geocoded") return `poi:${s.poiIdentity}`;
  if (s.kind === "stop") return `stop:${s.stopId}`;
  return `group:${s.groupId}`;
}

/** True for a geocoded suggestion sourced from a viewport tile (loses a score-tie
 *  to the canonical bundle row — mirrors deduplicateRecords). */
function isTileSuggestion(s: SearchSuggestion): boolean {
  return s.kind === "geocoded" && s.loadSource === "tile";
}

export async function searchStopsWithGroups(
  rawQuery: string,
  normalizedQuery: string,
  hint: LatLon | null,
  signal: AbortSignal,
  provider: SearchProvider,
): Promise<SearchSuggestion[]> {
  const usageCityId = useCityStore.getState().activeCity.id;
  const data = captureCityData(usageCityId);
  const stops = await fetchStopsForProvider(rawQuery, normalizedQuery, provider, signal);

  if (stops.length === 0) return [];

  const tapCounts = await loadTapCounts(stops.map((s) => s.id), usageCityId);

  const stopIds = new Set(stops.map((s) => s.id));
  const groups = await data.stopGroups
    .filter((g) => g.stopIds.some((id) => stopIds.has(id)) && g.stopIds.length > 1)
    .toArray();

  const groupedStopIds = new Set<string>();
  for (const g of groups) {
    for (const id of g.stopIds) groupedStopIds.add(id);
  }

  const suggestions: SearchSuggestion[] = [];

  for (const group of groups) {
    const memberStops = stops.filter((s) => group.stopIds.includes(s.id));
    if (memberStops.length === 0) continue;

    const bestMemberScore = Math.max(
      ...memberStops.map((s) => scoreStop(s, normalizedQuery, tapCounts, hint)),
    );

    suggestions.push({
      kind: "stopGroup",
      groupId: group.groupId,
      name: group.name,
      lat: group.lat,
      lon: group.lon,
      stopCount: group.stopIds.length,
      stopIds: group.stopIds,
      score: bestMemberScore + GROUP_BONUS,
    });
  }

  for (const stop of stops) {
    if (groupedStopIds.has(stop.id)) continue;
    suggestions.push({
      kind: "stop",
      stopId: stop.id,
      name: stop.name,
      lat: stop.location.lat,
      lon: stop.location.lon,
      score: scoreStop(stop, normalizedQuery, tapCounts, hint),
    });
  }

  data.assertCurrent();
  return suggestions;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

async function fetchStopsForProvider(
  rawQuery: string,
  normalizedQuery: string,
  provider: SearchProvider,
  signal: AbortSignal,
): Promise<Stop[]> {
  if (provider === "local") return searchLocalStops(normalizedQuery, signal);

  // Call-time third-party egress backstop, mirroring planViaTransitous
  // (services/transitousClient.ts): the remote provider reaches transitous even
  // though the PTN backend proxies the call, so it needs its own flow
  // (`external.stop-search`) — the operator hop does NOT exempt it. A stale
  // render or a persisted "remote" choice made before a revocation must not
  // egress either.
  //
  // Degrade to the local scan rather than returning nothing: the user asked for
  // stop results, and the local path reads the already-loaded stops table, so
  // there is no reason to hand back an empty list.
  if (!thirdPartyEgressAllowed()) {
    return searchLocalStops(normalizedQuery, signal);
  }

  // The local path doesn't share this gate — its scan is bounded by city size
  // and we want results from the first character. Backend rejects shorter
  // queries unconditionally, so the round-trip would just be empty anyway.
  if (normalizedQuery.length < REMOTE_STOP_SEARCH_MIN_CHARS) return [];

  try {
    const res = await api.searchStops(rawQuery, signal);
    if (!Array.isArray(res?.data)) {
      console.warn("[searchSuggestions] remote stops API returned non-array data:", res);
      return [];
    }
    return res.data;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.warn("[searchSuggestions] remote stops API failed:", err);
    return [];
  }
}

async function searchLocalStops(
  normalizedQuery: string,
  signal: AbortSignal,
): Promise<Stop[]> {
  if (!normalizedQuery) return [];

  const records = await captureCityData().gtfsStops.toArray();
  throwIfAborted(signal);
  if (records.length === 0) return [];

  const matches: Array<{ stop: Stop; score: number }> = [];
  for (let i = 0; i < records.length; i++) {
    // Cooperative abort: re-check every 256th record so a stale scan doesn't
    // block the next debounced query from getting the CPU. Throwing (not
    // returning []) is intentional — the outer Promise.all sees a real abort
    // and Search.tsx's catch can drop the result instead of clobbering fresh
    // suggestions with a stale empty array.
    if ((i & 0xff) === 0) throwIfAborted(signal);
    const r = records[i];
    const score = nameMatchScore(normalizedQuery, r.name);
    if (score > 0) {
      matches.push({
        stop: { id: r.id, name: r.name, location: { lat: r.lat, lon: r.lon } },
        score,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, LOCAL_STOP_LIMIT).map((m) => m.stop);
}

function scoreStop(
  stop: Stop,
  normalizedQuery: string,
  tapCounts: Map<string, { tapCount: number; lastTapped: number }>,
  hint: LatLon | null,
): number {
  // Scale base by match quality so prefix hits outrank substring hits.
  const matchScore = nameMatchScore(normalizedQuery, stop.name);
  let score = STOP_BASE_SCORE * (matchScore > 0 ? matchScore : STOP_FALLBACK_WEIGHT);

  const stat = tapCounts.get(stop.id);
  if (stat) {
    const hoursSince = (Date.now() - stat.lastTapped) / (1000 * 60 * 60);
    if (hoursSince < 24) score += 0.2;
    else if (hoursSince < 168) score += 0.1;
    score += Math.min(0.15, stat.tapCount * 0.03);
  }

  if (hint) {
    const dist = haversineMeters(
      hint.lat, hint.lon,
      stop.location.lat, stop.location.lon,
    );
    score += Math.max(0, 0.1 * (1 - dist / 50_000));
  }

  return score;
}

async function loadTapCounts(
  stopIds: string[],
  cityId: string,
): Promise<Map<string, { tapCount: number; lastTapped: number }>> {
  return loadStopUsage(stopIds, Date.now, cityId);
}

async function searchPoi(
  normalizedQuery: string,
  frontendCityId: string,
  hint: LatLon | null,
  signal: AbortSignal,
  requireCurrentTileGeneration: boolean,
): Promise<SearchSuggestion[]> {
  const allRecords: PoiIndexRecord[] = [];
  for (const cityId of poiCityIds(frontendCityId)) {
    const recs = await db.poiIndex
      .where("[cityId+name]")
      .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
      .toArray();
    allRecords.push(
      ...(requireCurrentTileGeneration
        ? recs.filter(isPoiRecordInCurrentTileGeneration)
        : recs),
    );
  }

  throwIfAborted(signal);

  const records = deduplicateRecords(allRecords.filter(isPoiCategoryEnabled));
  const suggestions: SearchSuggestion[] = [];

  for (const rec of records) {
    const s = self.scorePoiRecord(rec, normalizedQuery, hint);
    if (s) suggestions.push(s);
  }

  return suggestions;
}

export async function searchLocalAddresses(
  query: string,
  cityId: string,
  hint: LatLon | null,
  signal: AbortSignal,
): Promise<GeocodedSuggestion[]> {
  try {
    const candidates = await localAddressCandidates(cityId, query, hint, signal);
    return candidates.map((candidate) => addressCandidateToSuggestion(candidate, cityId));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    reportError(error instanceof Error ? error : new Error(String(error)), {
      context: { source: "searchLocalAddresses", cityId },
    });
    return [];
  }
}

/** Score a single POI record into a geocoded suggestion, or null when it doesn't
 *  match. Factored out of searchPoi so the initial full scan and the bounded
 *  per-emit merge score identically (no behavior fork). EXPORTED so AC-17 can spy
 *  on the engine's own calls. */
export function scorePoiRecord(
  rec: PoiIndexRecord,
  normalizedQuery: string,
  hint: LatLon | null,
): SearchSuggestion | null {
  if (!isPoiCategoryEnabled(rec)) return null;
  const aliases = flatAliases(rec.aliases);
  const score = scoreCandidate(
    normalizedQuery,
    rec.name,
    aliases,
    hint,
    rec.rankBoost,
    rec.lat,
    rec.lon,
  );
  if (score <= 0) return null;
  return {
    kind: "geocoded",
    label: rec.name,
    aliases: rec.aliases,
    ...(rec.address ? { address: rec.address } : {}),
    lat: rec.lat,
    lon: rec.lon,
    confidence: score,
    category: rec.category,
    source: rec.source,
    poiIdentity: rec.osmId ?? rec.id,
    loadSource: rec.loadSource,
    score,
  };
}
