// Micromap artifact builder.
//
// Input: GeoJSON features straight out of `osmium export` (one family per tag
// filter). Output: the `<city>.micromap.json` object the PWA fetches, decodes
// and hands to MapLibre. The whole point of the artifact is that it is TINY —
// a city you can orient yourself in, not a street database — so every family
// gets three knobs:
//
//   tolerance  — Douglas-Peucker in metres. A micromap is looked at between
//                z10 and z14; ~20 m of shape error is a fraction of a pixel
//                there and is invisible even zoomed in further.
//   minimum    — length (lines) or area (rings) below which a feature cannot
//                carry orientation value at those zooms. Ditches and
//                courtyard lawns are noise; the Neris and Vingis park are not.
//   max        — a hard cap, applied AFTER sorting by importance, so a feed
//                with an unusually generous mapper cannot blow the budget.
//                `buildMicromap` reports what it dropped rather than
//                silently truncating.
//
// Geometry is Google-encoded polylines (precision 5) so the client reuses the
// decoder it already ships for GTFS shapes.

import {
  lineLengthMeters,
  ringAreaMeters,
  simplifyLine,
  simplifyRing,
} from "./geometry.mjs";
import { dedupeQuantized, encodePolyline } from "./encode.mjs";

export const MICROMAP_VERSION = 1;

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

// Measured on Vilnius: road tolerance barely moves the
// byte count — OSM splits ways at every junction, so most road features are
// already 2-3 vertices — while ring tolerance and the area floors do. Hence a
// fine 10 m on roads (free shape fidelity) and a coarser 20/30 m on rings.
export const DEFAULT_LIMITS = Object.freeze({
  roads: { toleranceM: 10, minLengthM: 60, max: 4000 },
  waterways: { toleranceM: 20, minLengthM: 250, max: 1200 },
  water: {
    toleranceM: 20,
    minAreaM2: 10_000,
    holeMinAreaM2: 40_000,
    max: 1200,
  },
  green: { toleranceM: 30, minAreaM2: 40_000, holeMinAreaM2: 120_000, max: 900 },
  // Labels are the cheapest orientation per byte (~40 B each), so the cap is
  // generous: a three-city agglomeration like Tricity has ~290 named districts.
  places: { max: 400 },
});

/** Road classes we keep, most important first — also the render order. */
export const ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary"];
const ROAD_TAG_TO_CLASS = new Map([
  ["motorway", "motorway"],
  ["motorway_link", "motorway"],
  ["trunk", "trunk"],
  ["trunk_link", "trunk"],
  ["primary", "primary"],
  ["primary_link", "primary"],
  ["secondary", "secondary"],
  ["secondary_link", "secondary"],
]);

export const WATERWAY_CLASSES = ["river", "canal", "stream"];

/** place=* → label rank. Lower rank = bigger label, drawn first. */
const PLACE_RANKS = new Map([
  ["city", 1],
  ["town", 2],
  ["borough", 2],
  ["suburb", 3],
  ["quarter", 3],
  ["village", 4],
  ["neighbourhood", 4],
]);

export function roadClassOf(properties = {}) {
  return ROAD_TAG_TO_CLASS.get(properties.highway) ?? null;
}

export function waterwayClassOf(properties = {}) {
  const value = properties.waterway;
  return WATERWAY_CLASSES.includes(value) ? value : null;
}

export function placeRankOf(properties = {}) {
  return PLACE_RANKS.get(properties.place) ?? null;
}

function bboxContains(bbox, [lon, lat]) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function bboxIntersectsPoints(bbox, points) {
  return points.some((point) => bboxContains(bbox, point));
}

/** Every LineString in a feature, whatever its geometry type. */
function linesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

/** Every polygon (array of rings) in a feature, whatever its geometry type. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function encodeLine(points, toleranceM) {
  const simplified = dedupeQuantized(simplifyLine(points, toleranceM));
  return simplified.length >= 2 ? encodePolyline(simplified) : null;
}

/** Grid key for an endpoint, at the precision the polyline codec stores. */
function endpointKey([lon, lat]) {
  return `${Math.round(lon * 1e5)},${Math.round(lat * 1e5)}`;
}

/**
 * Chain segments that meet end-to-end into runs.
 *
 * OSM splits a road at every junction and at every attribute change, so one
 * boulevard arrives as dozens of features. Filtering those individually is
 * what made the first micromap look chopped up: a 40 m link between two long
 * stretches fell under `minLengthM` and left a visible hole (measured on
 * Vilnius: 416 holes, 13.2 km of missing connectors). Stitching first means
 * the length floor judges a whole run, and only genuinely isolated stubs go.
 *
 * Segments are joined only through endpoints where exactly two segments of the
 * same class meet — a junction of three or more is a real fork and picking a
 * branch there would invent geometry. Iteration follows input order so the
 * artifact stays byte-reproducible.
 */
export function stitchSegments(segments) {
  const incident = new Map();
  for (const [index, segment] of segments.entries()) {
    for (const key of [segment.startKey, segment.endKey]) {
      const list = incident.get(key);
      if (list) list.push(index);
      else incident.set(key, [index]);
    }
  }

  const used = new Set();
  const chains = [];
  for (const [index, segment] of segments.entries()) {
    if (used.has(index)) continue;
    used.add(index);
    let coordinates = [...segment.coordinates];
    let headKey = segment.startKey;
    let tailKey = segment.endKey;

    // Extend the tail, then the head. A ring stops on its own: the only
    // continuation left is a segment already in this chain.
    for (const atTail of [true, false]) {
      for (;;) {
        const fromKey = atTail ? tailKey : headKey;
        const nextIndex = continuationFor(incident, fromKey, used);
        if (nextIndex === null) break;
        const next = segments[nextIndex];
        const attachesAtItsStart = next.startKey === fromKey;
        const piece = attachesAtItsStart
          ? next.coordinates.slice(1)
          : [...next.coordinates].reverse().slice(1);
        if (atTail) {
          coordinates = [...coordinates, ...piece];
          tailKey = attachesAtItsStart ? next.endKey : next.startKey;
        } else {
          coordinates = [...piece.reverse(), ...coordinates];
          headKey = attachesAtItsStart ? next.endKey : next.startKey;
        }
        used.add(nextIndex);
      }
    }
    chains.push({ cls: segment.cls, coordinates });
  }
  return chains;
}

/** The single unused segment continuing at `key`, or null at a fork/dead end. */
function continuationFor(incident, key, used) {
  const list = incident.get(key);
  if (!list || list.length !== 2) return null;
  const candidates = list.filter((index) => !used.has(index));
  return candidates.length === 1 ? candidates[0] : null;
}

function collectLines({ features, bbox, classOf, limits }) {
  const byClass = new Map();
  for (const feature of features) {
    const cls = classOf(feature.properties ?? {});
    if (!cls) continue;
    for (const line of linesOf(feature.geometry)) {
      if (line.length < 2) continue;
      if (!bboxIntersectsPoints(bbox, line)) continue;
      const segment = {
        cls,
        coordinates: line,
        startKey: endpointKey(line[0]),
        endKey: endpointKey(line[line.length - 1]),
      };
      const list = byClass.get(cls);
      if (list) list.push(segment);
      else byClass.set(cls, [segment]);
    }
  }

  const out = [];
  let droppedShort = 0;
  for (const segments of byClass.values()) {
    const chains = stitchSegments(segments).map((chain) => ({
      chain,
      lengthM: lineLengthMeters(chain.coordinates),
      startKey: endpointKey(chain.coordinates[0]),
      endKey: endpointKey(chain.coordinates[chain.coordinates.length - 1]),
    }));

    // Stitching cannot join through a fork, so a short link between two
    // junctions survives as its own chain and the length floor would delete
    // it — reopening the holes stitching just closed. Keep any short chain
    // whose BOTH ends touch a chain that is being kept: that is a connector,
    // not a stub. Only dangling scraps are dropped.
    const anchors = new Set();
    for (const entry of chains) {
      if (entry.lengthM >= limits.minLengthM) {
        anchors.add(entry.startKey);
        anchors.add(entry.endKey);
      }
    }

    for (const entry of chains) {
      const isConnector =
        anchors.has(entry.startKey) && anchors.has(entry.endKey);
      if (entry.lengthM < limits.minLengthM && !isConnector) {
        droppedShort++;
        continue;
      }
      const encoded = encodeLine(entry.chain.coordinates, limits.toleranceM);
      if (encoded) {
        out.push({ c: entry.chain.cls, g: encoded, _length: entry.lengthM });
      }
    }
  }
  return { entries: out, droppedShort };
}

function collectAreas({ features, bbox, limits }) {
  const out = [];
  let droppedSmall = 0;
  for (const feature of features) {
    for (const polygon of polygonsOf(feature.geometry)) {
      const [outer, ...holes] = polygon;
      if (!outer || outer.length < 4) continue;
      if (!bboxIntersectsPoints(bbox, outer)) continue;
      const areaM2 = ringAreaMeters(outer);
      if (areaM2 < limits.minAreaM2) {
        droppedSmall++;
        continue;
      }
      const simplifiedOuter = simplifyRing(outer, limits.toleranceM);
      if (!simplifiedOuter) continue;
      const rings = [encodePolyline(dedupeQuantized(simplifiedOuter))];
      for (const hole of holes) {
        if (ringAreaMeters(hole) < limits.holeMinAreaM2) continue;
        const simplifiedHole = simplifyRing(hole, limits.toleranceM);
        if (simplifiedHole) {
          rings.push(encodePolyline(dedupeQuantized(simplifiedHole)));
        }
      }
      out.push({ r: rings, _area: areaM2 });
    }
  }
  return { entries: out, droppedSmall };
}

function collectPlaces({ features, bbox }) {
  const out = [];
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const rank = placeRankOf(properties);
    if (rank === null) continue;
    const name = properties.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== "Point") continue;
    const [lon, lat] = geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!bboxContains(bbox, [lon, lat])) continue;
    out.push({
      n: name,
      y: Math.round(lat * 1e5) / 1e5,
      x: Math.round(lon * 1e5) / 1e5,
      r: rank,
    });
  }
  return out;
}

function capBy(entries, max, compare) {
  const sorted = [...entries].sort(compare);
  return { kept: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}

function strip(entries) {
  return entries.map(({ _length, _area, ...rest }) => rest);
}

/**
 * Assemble the artifact.
 *
 * `features` holds one array of GeoJSON features per family, already filtered
 * by `osmium tags-filter` (the builder re-checks the tags anyway, so hand-made
 * inputs and test fixtures behave identically).
 */
export function buildMicromap({
  cityId,
  bbox,
  generatedAt,
  features,
  limits = DEFAULT_LIMITS,
}) {
  const roads = collectLines({
    features: features.roads ?? [],
    bbox,
    classOf: roadClassOf,
    limits: limits.roads,
  });
  const waterways = collectLines({
    features: features.waterways ?? [],
    bbox,
    classOf: waterwayClassOf,
    limits: limits.waterways,
  });
  const water = collectAreas({
    features: features.water ?? [],
    bbox,
    limits: limits.water,
  });
  const green = collectAreas({
    features: features.green ?? [],
    bbox,
    limits: limits.green,
  });
  const places = collectPlaces({ features: features.places ?? [], bbox });

  // Importance order per family, so the caps below keep the features that
  // carry orientation: bigger roads before smaller, longer before shorter,
  // larger areas before smaller, bigger places before smaller.
  const roadCap = capBy(roads.entries, limits.roads.max, (a, b) => {
    const byClass = ROAD_CLASSES.indexOf(a.c) - ROAD_CLASSES.indexOf(b.c);
    return byClass !== 0 ? byClass : b._length - a._length;
  });
  const waterwayCap = capBy(
    waterways.entries,
    limits.waterways.max,
    (a, b) => b._length - a._length,
  );
  const waterCap = capBy(water.entries, limits.water.max, (a, b) => b._area - a._area);
  const greenCap = capBy(green.entries, limits.green.max, (a, b) => b._area - a._area);
  const placeCap = capBy(places, limits.places.max, (a, b) =>
    a.r !== b.r ? a.r - b.r : a.n.localeCompare(b.n),
  );

  const artifact = {
    version: MICROMAP_VERSION,
    cityId,
    generatedAt,
    attribution: OSM_ATTRIBUTION,
    bbox,
    water: strip(waterCap.kept),
    green: strip(greenCap.kept),
    waterways: strip(waterwayCap.kept),
    roads: strip(roadCap.kept),
    places: placeCap.kept,
  };

  const stats = {
    counts: {
      water: artifact.water.length,
      green: artifact.green.length,
      waterways: artifact.waterways.length,
      roads: artifact.roads.length,
      places: artifact.places.length,
    },
    dropped: {
      waterBelowMinArea: water.droppedSmall,
      greenBelowMinArea: green.droppedSmall,
      roadsBelowMinLength: roads.droppedShort,
      waterwaysBelowMinLength: waterways.droppedShort,
      overCap: {
        water: waterCap.dropped,
        green: greenCap.dropped,
        waterways: waterwayCap.dropped,
        roads: roadCap.dropped,
        places: placeCap.dropped,
      },
    },
  };

  return { artifact, stats };
}
