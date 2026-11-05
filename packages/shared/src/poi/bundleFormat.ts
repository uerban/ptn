export type Tier = "strict" | "loose";

export function normalizePoiText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u0142/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PoiEntry {
  id: string;
  name: string;
  aliases: Record<string, string[]>;
  /** Optional mapped address context for distinguishing search results. */
  address?: { street?: string; houseNumber?: string; locality?: string };
  category: string;
  lat: number;
  lon: number;
  source: "curated" | "osm";
  rankBoost: number;
  wikidataId?: string;
  nearestStopGroupId?: string | null;
  osmId?: string;
  tier: Tier;
}

export interface PoiBundleMeta {
  cityId: string;
  version: string;
  attribution: "\u00a9 OpenStreetMap contributors";
  licenseUrl: "https://opendatacommons.org/licenses/odbl/";
  sourcePbfTimestamp: string;
  bundleGeneratedAt: string;
  tier: Tier;
  entryCount: number;
}

export interface PoiBundle {
  meta: PoiBundleMeta;
  entries: PoiEntry[];
}
