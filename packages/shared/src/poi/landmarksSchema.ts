// Runtime validator + TypeScript types for curated landmark JSON files under
// packages/shared/data/landmarks/<cityId>.json. Zero external deps — we walk
// the structure manually and collect every violation so CI surfaces the full
// picture in one pass.

export type LandmarkCategory =
  | "airport"
  | "bus_terminal"
  | "cultural_venue"
  | "hospital"
  | "landmark"
  | "mall"
  | "museum"
  | "park"
  | "square"
  | "stadium"
  | "theater"
  | "train_station"
  | "university";

export const LANDMARK_CATEGORIES: readonly LandmarkCategory[] = [
  "airport",
  "bus_terminal",
  "cultural_venue",
  "hospital",
  "landmark",
  "mall",
  "museum",
  "park",
  "square",
  "stadium",
  "theater",
  "train_station",
  "university",
] as const;

export type LandmarkCityId = "gdansk" | "gdynia" | "sopot" | "vilnius" | "tbilisi";

export const LANDMARK_CITY_IDS: readonly LandmarkCityId[] = [
  "gdansk",
  "gdynia",
  "sopot",
  "vilnius",
  "tbilisi",
] as const;

export type LandmarkLang = "be" | "en" | "lt" | "pl" | "ru" | "uk";

export const LANDMARK_LANGS: readonly LandmarkLang[] = [
  "be",
  "en",
  "lt",
  "pl",
  "ru",
  "uk",
] as const;

export interface LandmarkAliases {
  readonly be?: readonly string[];
  readonly en?: readonly string[];
  readonly lt?: readonly string[];
  readonly pl?: readonly string[];
  readonly ru?: readonly string[];
  readonly uk?: readonly string[];
}

export interface LandmarkEntry {
  readonly id: string;
  readonly city: LandmarkCityId;
  readonly canonicalName: string;
  readonly aliases: LandmarkAliases;
  readonly category: LandmarkCategory;
  readonly lat: number;
  readonly lon: number;
  readonly bbox: readonly [number, number, number, number];
  readonly nearestStopGroupId: string | null;
  readonly wikidataId?: string;
  readonly source: "curated";
  readonly sourceVersion: string;
  readonly needsNativeReview: boolean;
}

export interface LandmarkFileMeta {
  readonly generated: string;
  readonly sourceVersion: string;
  readonly entryCount: number;
  readonly needsReviewCount: number;
  readonly notes?: string;
}

export interface LandmarkFile {
  readonly _meta: LandmarkFileMeta;
  readonly entries: readonly LandmarkEntry[];
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: LandmarkFile }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export interface LandmarkFileSummary {
  readonly cityId: LandmarkCityId;
  readonly entryCount: number;
  readonly needsNativeReviewCount: number;
  readonly categoryCounts: Readonly<Record<LandmarkCategory, number>>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WIKIDATA_ID_RE = /^Q\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEntry(
  raw: unknown,
  index: number,
  expectedCity: LandmarkCityId | null,
  seenIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const prefix = `entries[${index}]`;
  if (!isPlainObject(raw)) {
    issues.push({ path: prefix, message: "must be an object" });
    return;
  }

  const e = raw;

  if (typeof e.id !== "string" || e.id.length === 0) {
    issues.push({ path: `${prefix}.id`, message: "must be a non-empty string" });
  } else if (seenIds.has(e.id)) {
    issues.push({ path: `${prefix}.id`, message: `duplicate id "${e.id}"` });
  } else {
    seenIds.add(e.id);
  }

  if (typeof e.city !== "string" || !LANDMARK_CITY_IDS.includes(e.city as LandmarkCityId)) {
    issues.push({
      path: `${prefix}.city`,
      message: `must be one of ${LANDMARK_CITY_IDS.join(", ")}`,
    });
  } else if (expectedCity !== null && e.city !== expectedCity) {
    issues.push({
      path: `${prefix}.city`,
      message: `expected "${expectedCity}" to match file name, got "${e.city}"`,
    });
  }

  if (typeof e.canonicalName !== "string" || e.canonicalName.trim().length === 0) {
    issues.push({
      path: `${prefix}.canonicalName`,
      message: "must be a non-empty string",
    });
  }

  if (!isPlainObject(e.aliases)) {
    issues.push({ path: `${prefix}.aliases`, message: "must be an object" });
  } else {
    for (const [lang, list] of Object.entries(e.aliases)) {
      const alPath = `${prefix}.aliases.${lang}`;
      if (!LANDMARK_LANGS.includes(lang as LandmarkLang)) {
        issues.push({ path: alPath, message: `unknown language code "${lang}"` });
      }
      if (!Array.isArray(list)) {
        issues.push({ path: alPath, message: "must be an array of strings" });
        continue;
      }
      list.forEach((a, i) => {
        if (typeof a !== "string" || a.length === 0) {
          issues.push({
            path: `${alPath}[${i}]`,
            message: "must be a non-empty string",
          });
        }
      });
    }
  }

  if (typeof e.category !== "string" || !LANDMARK_CATEGORIES.includes(e.category as LandmarkCategory)) {
    issues.push({
      path: `${prefix}.category`,
      message: `must be one of ${LANDMARK_CATEGORIES.join(", ")}`,
    });
  }

  if (typeof e.lat !== "number" || !Number.isFinite(e.lat) || e.lat < -90 || e.lat > 90) {
    issues.push({ path: `${prefix}.lat`, message: "must be a finite number in [-90, 90]" });
  }
  if (typeof e.lon !== "number" || !Number.isFinite(e.lon) || e.lon < -180 || e.lon > 180) {
    issues.push({ path: `${prefix}.lon`, message: "must be a finite number in [-180, 180]" });
  }

  if (
    !Array.isArray(e.bbox) ||
    e.bbox.length !== 4 ||
    !e.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    issues.push({
      path: `${prefix}.bbox`,
      message: "must be [minLat, minLon, maxLat, maxLon] with finite numbers",
    });
  } else {
    const [minLat, minLon, maxLat, maxLon] = e.bbox as [number, number, number, number];
    if (minLat > maxLat) {
      issues.push({
        path: `${prefix}.bbox`,
        message: `minLat (${minLat}) must be <= maxLat (${maxLat})`,
      });
    }
    if (minLon > maxLon) {
      issues.push({
        path: `${prefix}.bbox`,
        message: `minLon (${minLon}) must be <= maxLon (${maxLon})`,
      });
    }
    if (typeof e.lat === "number" && (e.lat < minLat || e.lat > maxLat)) {
      issues.push({
        path: `${prefix}.bbox`,
        message: `lat ${e.lat} is outside bbox lat range [${minLat}, ${maxLat}]`,
      });
    }
    if (typeof e.lon === "number" && (e.lon < minLon || e.lon > maxLon)) {
      issues.push({
        path: `${prefix}.bbox`,
        message: `lon ${e.lon} is outside bbox lon range [${minLon}, ${maxLon}]`,
      });
    }
  }

  if (e.nearestStopGroupId !== null && typeof e.nearestStopGroupId !== "string") {
    issues.push({
      path: `${prefix}.nearestStopGroupId`,
      message: "must be string or null",
    });
  }

  if (e.wikidataId !== undefined) {
    if (typeof e.wikidataId !== "string" || !WIKIDATA_ID_RE.test(e.wikidataId)) {
      issues.push({
        path: `${prefix}.wikidataId`,
        message: 'must match /^Q\\d+$/ (e.g. "Q16125")',
      });
    }
  }

  if (e.source !== "curated") {
    issues.push({ path: `${prefix}.source`, message: 'must be "curated"' });
  }

  if (typeof e.sourceVersion !== "string" || !ISO_DATE_RE.test(e.sourceVersion)) {
    issues.push({
      path: `${prefix}.sourceVersion`,
      message: "must be an ISO date string YYYY-MM-DD",
    });
  }

  if (typeof e.needsNativeReview !== "boolean") {
    issues.push({
      path: `${prefix}.needsNativeReview`,
      message: "must be boolean",
    });
  }
}

function validateMeta(raw: unknown, issues: ValidationIssue[]): void {
  if (!isPlainObject(raw)) {
    issues.push({ path: "_meta", message: "must be an object" });
    return;
  }
  if (typeof raw.generated !== "string" || !ISO_DATE_RE.test(raw.generated)) {
    issues.push({
      path: "_meta.generated",
      message: "must be ISO date string YYYY-MM-DD",
    });
  }
  if (typeof raw.sourceVersion !== "string" || !ISO_DATE_RE.test(raw.sourceVersion)) {
    issues.push({
      path: "_meta.sourceVersion",
      message: "must be ISO date string YYYY-MM-DD",
    });
  }
  if (typeof raw.entryCount !== "number" || !Number.isInteger(raw.entryCount) || raw.entryCount < 0) {
    issues.push({
      path: "_meta.entryCount",
      message: "must be a non-negative integer",
    });
  }
  if (
    typeof raw.needsReviewCount !== "number" ||
    !Number.isInteger(raw.needsReviewCount) ||
    raw.needsReviewCount < 0
  ) {
    issues.push({
      path: "_meta.needsReviewCount",
      message: "must be a non-negative integer",
    });
  }
  if (raw.notes !== undefined && typeof raw.notes !== "string") {
    issues.push({ path: "_meta.notes", message: "must be string if present" });
  }
}

export function validateLandmarkFile(
  raw: unknown,
  opts: { expectedCity?: LandmarkCityId } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: "$", message: "root must be an object" }] };
  }

  validateMeta(raw._meta, issues);

  if (!Array.isArray(raw.entries)) {
    issues.push({ path: "entries", message: "must be an array" });
    return { ok: false, issues };
  }

  const expectedCity = opts.expectedCity ?? null;
  const seenIds = new Set<string>();
  raw.entries.forEach((entry, i) =>
    validateEntry(entry, i, expectedCity, seenIds, issues),
  );

  // Cross-field invariants (only meaningful if _meta + entries individually OK).
  if (isPlainObject(raw._meta)) {
    const meta = raw._meta;
    if (typeof meta.entryCount === "number" && meta.entryCount !== raw.entries.length) {
      issues.push({
        path: "_meta.entryCount",
        message: `declared ${meta.entryCount} but file has ${raw.entries.length} entries`,
      });
    }
    if (typeof meta.needsReviewCount === "number") {
      const actual = raw.entries.filter(
        (e) => isPlainObject(e) && e.needsNativeReview === true,
      ).length;
      if (meta.needsReviewCount !== actual) {
        issues.push({
          path: "_meta.needsReviewCount",
          message: `declared ${meta.needsReviewCount} but ${actual} entries have needsNativeReview=true`,
        });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: raw as unknown as LandmarkFile };
}

export function summarizeLandmarkFile(file: LandmarkFile): LandmarkFileSummary {
  const categoryCounts = Object.fromEntries(
    LANDMARK_CATEGORIES.map((c) => [c, 0]),
  ) as Record<LandmarkCategory, number>;

  let needsReview = 0;
  const cityIds = new Set<LandmarkCityId>();
  for (const e of file.entries) {
    categoryCounts[e.category] += 1;
    if (e.needsNativeReview) needsReview += 1;
    cityIds.add(e.city);
  }

  // File is assumed valid, so all entries share one city.
  const cityId = cityIds.values().next().value as LandmarkCityId;

  return {
    cityId,
    entryCount: file.entries.length,
    needsNativeReviewCount: needsReview,
    categoryCounts,
  };
}
