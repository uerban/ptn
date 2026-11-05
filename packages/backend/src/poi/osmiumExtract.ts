import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CategorySpec, Predicate, Rule, TagSpec, Tier } from "./osmTags.js";

/** A minimal OSM feature as produced by `osmium export -f geojsonseq`. */
export interface OsmFeature {
  id: string;
  type: "node" | "way" | "relation";
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface CategorizedOsmFeature extends OsmFeature {
  tier: Tier;
  category: string;
}

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface ExtractOptions {
  bbox?: BBox;
  /** Override path to the osmium binary. Defaults to "osmium" on PATH. */
  osmiumBin?: string;
}

function matchPredicate(pred: Predicate, tags: Record<string, string>): boolean {
  const value = tags[pred.key];
  if (value === undefined || value === "") return false;
  if (pred.kind === "present") return true;
  return pred.values.includes(value);
}

function matchRule(rule: Rule, tags: Record<string, string>): boolean {
  return rule.predicates.every((p) => matchPredicate(p, tags));
}

/** True if `tags` match any include-rule and no exclude-rule for `cat`. */
export function matchCategory(tags: Record<string, string>, cat: CategorySpec): boolean {
  if (cat.nameRequired && !tags.name) return false;
  if (!cat.include.some((r) => matchRule(r, tags))) return false;
  return !cat.exclude.some((r) => matchRule(r, tags));
}

/** Return the first matching category name within `tierSpec`, or null. */
export function categorize(
  tags: Record<string, string>,
  tierSpec: Record<string, CategorySpec>
): string | null {
  for (const [name, spec] of Object.entries(tierSpec)) {
    if (matchCategory(tags, spec)) return name;
  }
  return null;
}

function inBBox(lat: number, lon: number, bbox: BBox): boolean {
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

/**
 * Filter an iterable of OSM features down to the ones matching any category
 * of the given tier. Preserves feature order; emits one `CategorizedOsmFeature`
 * per match (a feature matches at most one category — the first one hit).
 */
export async function* filterFeatures(
  features: AsyncIterable<OsmFeature> | Iterable<OsmFeature>,
  spec: TagSpec,
  tier: Tier,
  opts: { bbox?: BBox } = {}
): AsyncGenerator<CategorizedOsmFeature> {
  const tierSpec = spec[tier];
  for await (const f of features as AsyncIterable<OsmFeature>) {
    if (opts.bbox && !inBBox(f.lat, f.lon, opts.bbox)) continue;
    if (tier === "loose" && categorize(f.tags, spec.strict)) continue;
    const category = categorize(f.tags, tierSpec);
    if (!category) continue;
    yield { ...f, tier, category };
  }
}

/**
 * Stream OSM features out of a PBF/XML file via the `osmium` system binary.
 * Uses `osmium export -f geojsonseq` so each record is one GeoJSON Feature per
 * line. Point features are emitted with their coordinates; non-point geometries
 * (ways/relations) are reduced to the arithmetic mean of all coordinates.
 *
 * When a bbox is supplied, features are kept by their reduced point. The file
 * is NOT cropped with `osmium extract --bbox` first. Extract (and tags-filter)
 * keep dense ID bitsets that grow with how widely the input's IDs spread, not
 * with its size, and a regional file has nodes across the whole ID range: one
 * extract of the 118 MB pomorskie file peaked at 3.5 GB, and the OOM killer
 * took it on the CI hosts (exit status null, no message). Export alone peaks
 * at 360 MB for pomorskie and 760 MB for lithuania.
 *
 * Requires `osmium-tool` to be installed on PATH (apt: osmium-tool, brew: osmium-tool).
 */
export async function* runOsmiumExport(
  inputPath: string,
  opts: ExtractOptions = {}
): AsyncGenerator<OsmFeature> {
  const bin = opts.osmiumBin ?? "osmium";
  const bbox = opts.bbox;

  // -a type,id: osmium export's default attribute set is empty, so without
  // this every feature's @type/@id properties are absent and splitProps'
  // osmType fallback ("node") silently applies to ways/relations too.
  const child = spawn(
    bin,
    ["export", "-f", "geojsonseq", "-a", "type,id", inputPath],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let childError: Error | undefined;
  const exitPromise = new Promise<string | null>((resolve) => {
    child.on("error", (err) => {
      childError = err;
      resolve("error");
    });
    child.on("exit", (code, signal) =>
      resolve(code === 0 ? null : signal ? `signal ${signal}` : `code ${code}`),
    );
  });

  let stdoutDrained = false;
  try {
    for await (const line of rl) {
      const feature = parseGeojsonSeqLine(line);
      if (!feature) continue;
      if (bbox && !inBBox(feature.lat, feature.lon, bbox)) continue;
      yield feature;
    }
    stdoutDrained = true;
  } finally {
    rl.close();
    // A caller can stop consuming the async generator early. In that case the
    // child may still be writing, so close it explicitly. If stdout drained
    // normally, wait for the process to report its real exit status below.
    if (!stdoutDrained && !child.killed) child.kill();
  }

  const failure = await exitPromise;
  if (failure !== null) {
    throw childError ?? new Error(`osmium export exited with ${failure}`);
  }
}

/** One (bbox, tier) slice wanted from a source file. */
export interface ExtractTarget {
  key: string;
  bbox: BBox;
  tier: Tier;
}

/**
 * Read `inputPath` once and sort matching features into every target, so
 * several cities and tiers that share one regional file cost one export pass.
 * Same per-target result as `extractFromPbf(inputPath, spec, t.tier, { bbox: t.bbox })`.
 */
export async function extractTargetsFromPbf(
  inputPath: string,
  spec: TagSpec,
  targets: readonly ExtractTarget[],
  opts: Pick<ExtractOptions, "osmiumBin"> = {},
): Promise<Map<string, CategorizedOsmFeature[]>> {
  const out = new Map<string, CategorizedOsmFeature[]>();
  for (const t of targets) out.set(t.key, []);
  for await (const f of runOsmiumExport(inputPath, opts)) {
    for (const t of targets) {
      if (!inBBox(f.lat, f.lon, t.bbox)) continue;
      if (t.tier === "loose" && categorize(f.tags, spec.strict)) continue;
      const category = categorize(f.tags, spec[t.tier]);
      if (category) out.get(t.key)!.push({ ...f, tier: t.tier, category });
    }
  }
  return out;
}

function parseGeojsonSeqLine(line: string): OsmFeature | null {
  // RFC 8142 geojsonseq prefixes each record with RS (0x1e). Strip it.
  const trimmed = line.replace(/^\x1e/, "").trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const f = obj as {
    type?: string;
    geometry?: { type?: string; coordinates?: unknown };
    properties?: Record<string, unknown>;
    id?: string | number;
  };
  if (f.type !== "Feature" || !f.geometry || !f.properties) return null;

  const [lon, lat] = extractPoint(f.geometry);
  if (lat === null || lon === null) return null;

  const { osmType, osmId, tags } = splitProps(f.properties, f.id);
  return {
    id: osmId,
    type: osmType,
    lat,
    lon,
    tags,
  };
}

export function extractPoint(geom: { type?: string; coordinates?: unknown }): [number | null, number | null] {
  const c = geom.coordinates;
  if (geom.type === "Point" && Array.isArray(c) && c.length >= 2) {
    return [Number(c[0]), Number(c[1])];
  }
  if (geom.type === "Polygon" && Array.isArray(c)) {
    const centroid = polygonCentroid(c);
    if (centroid) return centroid;
  }
  if (geom.type === "MultiPolygon" && Array.isArray(c)) {
    const centroid = multiPolygonCentroid(c);
    if (centroid) return centroid;
  }
  const avg = averageCoord(c);
  if (avg) return avg;
  return [null, null];
}

function ringCentroid(ring: unknown): [number, number] | null {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i] as [number, number];
    const [x1, y1] = ring[i + 1] as [number, number];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-12) return null;
  area *= 0.5;
  cx /= 6 * area;
  cy /= 6 * area;
  return [cx, cy];
}

function polygonCentroid(rings: unknown): [number, number] | null {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  let totalArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    const centroid = ringCentroid(ring);
    if (!centroid) continue;
    const area = ringArea(ring);
    totalArea += area;
    cx += centroid[0] * area;
    cy += centroid[1] * area;
  }
  if (Math.abs(totalArea) < 1e-12) return null;
  const pt: [number, number] = [cx / totalArea, cy / totalArea];
  if (insidePolygon(pt[0], pt[1], rings)) return pt;
  return interiorFallback(pt, rings) ?? pt;
}

function multiPolygonCentroid(polygons: unknown): [number, number] | null {
  if (!Array.isArray(polygons)) return null;
  let totalArea = 0;
  let cx = 0;
  let cy = 0;
  const valid: { rings: unknown[]; centroid: [number, number]; absArea: number }[] = [];
  for (const poly of polygons) {
    if (!Array.isArray(poly) || poly.length === 0) continue;
    const centroid = polygonCentroid(poly);
    if (!centroid) continue;
    let polyArea = 0;
    for (let i = 0; i < (poly as unknown[]).length; i++) {
      polyArea += ringArea((poly as unknown[])[i]);
    }
    const absArea = Math.abs(polyArea);
    totalArea += absArea;
    cx += centroid[0] * absArea;
    cy += centroid[1] * absArea;
    valid.push({ rings: poly as unknown[], centroid, absArea });
  }
  if (totalArea < 1e-12) return null;
  const pt: [number, number] = [cx / totalArea, cy / totalArea];
  for (const { rings } of valid) {
    if (insidePolygon(pt[0], pt[1], rings)) return pt;
  }
  let best: [number, number] | null = null;
  let bestArea = 0;
  for (const { centroid, absArea } of valid) {
    if (absArea > bestArea) {
      bestArea = absArea;
      best = centroid;
    }
  }
  return best;
}

function ringArea(ring: unknown): number {
  if (!Array.isArray(ring)) return 0;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i] as [number, number];
    const [x1, y1] = ring[i + 1] as [number, number];
    area += x0 * y1 - x1 * y0;
  }
  return area * 0.5;
}

function pointInRing(px: number, py: number, ring: unknown): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function insidePolygon(px: number, py: number, rings: unknown[]): boolean {
  if (!pointInRing(px, py, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(px, py, rings[i])) return false;
  }
  return true;
}

function interiorFallback(centroid: [number, number], rings: unknown[]): [number, number] | null {
  const y = centroid[1];
  const xs: number[] = [];
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i] as [number, number];
      const [x1, y1] = ring[i + 1] as [number, number];
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
      }
    }
  }
  xs.sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < xs.length - 1; i++) {
    const mid = (xs[i] + xs[i + 1]) / 2;
    if (insidePolygon(mid, y, rings)) {
      const d = Math.abs(mid - centroid[0]);
      if (d < bestDist) {
        bestDist = d;
        best = [mid, y];
      }
    }
  }
  return best;
}

function collectCoords(c: unknown, out: [number, number][]): void {
  if (!Array.isArray(c)) return;
  if (typeof c[0] === "number" && typeof c[1] === "number") {
    out.push([c[0] as number, c[1] as number]);
    return;
  }
  for (const el of c) {
    collectCoords(el, out);
  }
}

function averageCoord(c: unknown): [number, number] | null {
  const coords: [number, number][] = [];
  collectCoords(c, coords);
  if (coords.length === 0) return null;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / coords.length, sumLat / coords.length];
}

function splitProps(
  props: Record<string, unknown>,
  rawId: string | number | undefined
): { osmType: OsmFeature["type"]; osmId: string; tags: Record<string, string> } {
  // osmium geojsonseq puts OSM metadata under a "@" prefix (@id, @type), and
  // plain tag keys at the top level.
  const tags: Record<string, string> = {};
  let osmType: OsmFeature["type"] = "node";
  let osmId = "";
  for (const [k, v] of Object.entries(props)) {
    if (k === "@type" || k === "type") {
      if (v === "node" || v === "way" || v === "relation") osmType = v;
      continue;
    }
    if (k === "@id" || k === "id") {
      osmId = String(v);
      continue;
    }
    if (k.startsWith("@")) continue;
    if (typeof v === "string") tags[k] = v;
    else if (v !== null && v !== undefined) tags[k] = String(v);
  }
  if (!osmId && rawId !== undefined) osmId = String(rawId);
  return { osmType, osmId, tags };
}

/**
 * High-level: run osmium on a PBF (or `.osm` XML) file and yield the subset of
 * features that match the given tier of the tag spec, annotated with their
 * category.
 */
export async function* extractFromPbf(
  inputPath: string,
  spec: TagSpec,
  tier: Tier,
  opts: ExtractOptions = {}
): AsyncGenerator<CategorizedOsmFeature> {
  yield* filterFeatures(runOsmiumExport(inputPath, opts), spec, tier, { bbox: opts.bbox });
}
