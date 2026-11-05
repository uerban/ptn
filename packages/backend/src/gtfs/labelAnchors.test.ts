import { describe, it, expect } from "vitest";
import {
  computeLabelAnchors,
  pairRadius,
  sameLogicalStop,
  type LabelAnchor,
} from "./labelAnchors.js";
import type { GtfsStop } from "./parser.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function stop(id: string, name: string, lat: number, lon: number): GtfsStop {
  return { id, name, lat, lon, parentStation: "" };
}

const OPPOSITE: Record<LabelAnchor, LabelAnchor> = {
  right: "left",
  "top-right": "bottom-left",
  top: "bottom",
  "top-left": "bottom-right",
  left: "right",
  "bottom-left": "top-right",
  bottom: "top",
  "bottom-right": "top-left",
};

// ── Brute-force reference (independent O(n²) port of the prototype) ───────────
//
// Uses full-array neighbor scans (no spatial grid). The grid-equivalence test asserts the production module
// reproduces this byte-for-byte, locking the optimization to the validated
// behavior.

const DIRS: LabelAnchor[] = [
  "right",
  "top-right",
  "top",
  "top-left",
  "left",
  "bottom-left",
  "bottom",
  "bottom-right",
];

function geoDist(a: GtfsStop, b: GtfsStop): number {
  const dlat = a.lat - b.lat;
  const dlon = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dlat * dlat + dlon * dlon);
}
function refPairRadius(a: GtfsStop, b: GtfsStop): number {
  const same =
    a.name === b.name ||
    (a.name.replace(/\s*\d+$/, "").trim() === b.name.replace(/\s*\d+$/, "").trim() &&
      a.name.replace(/\s*\d+$/, "").trim().length > 0);
  return same ? 0.003 : 0.0012;
}
function angleToIdx(angle: number): number {
  return Math.round(((((angle % 360) + 360) % 360) / 45)) % 8;
}
function pickBest(pref: number, taken: Set<number>): number {
  if (!taken.has(pref)) return pref;
  let bestIdx = pref;
  let bestScore = Infinity;
  for (let delta = 1; delta < 8; delta++) {
    for (const sign of [1, -1]) {
      const idx = (((pref + delta * sign) % 8) + 8) % 8;
      if (taken.has(idx)) continue;
      if (delta < bestScore) {
        bestScore = delta;
        bestIdx = idx;
      }
    }
    if (bestScore <= delta) break;
  }
  return bestIdx;
}

function bruteForce(stops: GtfsStop[]): Map<string, LabelAnchor> {
  const repulsion = stops.map((s, i) => {
    let dx = 0;
    let dy = 0;
    let n = 0;
    for (let j = 0; j < stops.length; j++) {
      if (i === j) continue;
      const d = geoDist(s, stops[j]);
      if (d > refPairRadius(s, stops[j])) continue;
      const w = 1 / (d * d + 1e-8);
      dx += (s.lon - stops[j].lon) * w;
      dy += (s.lat - stops[j].lat) * w;
      n++;
    }
    return n ? (Math.atan2(dy, dx) * 180) / Math.PI : 0;
  });

  const dirs: (number | null)[] = new Array(stops.length).fill(null);
  const neighbors = stops.map((s, i) => {
    const nb: number[] = [];
    for (let j = 0; j < stops.length; j++) {
      if (i !== j && geoDist(s, stops[j]) < refPairRadius(s, stops[j])) nb.push(j);
    }
    return nb;
  });

  const isPurePair = new Array(stops.length).fill(false);
  for (let i = 0; i < stops.length; i++) {
    if (neighbors[i].length === 1) {
      const j = neighbors[i][0];
      if (neighbors[j].length === 1 && neighbors[j][0] === i) {
        isPurePair[i] = true;
        isPurePair[j] = true;
      }
    }
  }
  for (let i = 0; i < stops.length; i++) {
    if (!isPurePair[i] || dirs[i] !== null) continue;
    const j = neighbors[i][0];
    const awayI =
      (Math.atan2(stops[i].lat - stops[j].lat, stops[i].lon - stops[j].lon) * 180) /
      Math.PI;
    const awayJ =
      (Math.atan2(stops[j].lat - stops[i].lat, stops[j].lon - stops[i].lon) * 180) /
      Math.PI;
    dirs[i] = angleToIdx(awayI);
    dirs[j] = angleToIdx(awayJ);
  }

  const edges: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (dirs[i] !== null) continue;
    for (const j of neighbors[i]) {
      if (j > i && dirs[j] === null)
        edges.push({ i, j, d: geoDist(stops[i], stops[j]) });
    }
  }
  edges.sort((a, b) => a.d - b.d);
  for (const { i, j } of edges) {
    if (dirs[i] !== null && dirs[j] !== null) continue;
    if (dirs[i] === null && dirs[j] === null) {
      const awayI =
        (Math.atan2(stops[i].lat - stops[j].lat, stops[i].lon - stops[j].lon) *
          180) /
        Math.PI;
      const awayJ = ((awayI + 180) % 360) - 180;
      const takenI = new Set<number>();
      const takenJ = new Set<number>();
      for (const n of neighbors[i]) if (dirs[n] !== null) takenI.add(dirs[n] as number);
      for (const n of neighbors[j]) if (dirs[n] !== null) takenJ.add(dirs[n] as number);
      dirs[i] = pickBest(angleToIdx(awayI), takenI);
      takenJ.add(dirs[i] as number);
      dirs[j] = pickBest(angleToIdx(awayJ), takenJ);
    } else {
      const [resolved, unresolved] = dirs[i] !== null ? [i, j] : [j, i];
      const taken = new Set<number>();
      for (const n of neighbors[unresolved])
        if (dirs[n] !== null) taken.add(dirs[n] as number);
      const awayAngle =
        (Math.atan2(
          stops[unresolved].lat - stops[resolved].lat,
          stops[unresolved].lon - stops[resolved].lon,
        ) *
          180) /
        Math.PI;
      dirs[unresolved] = pickBest(angleToIdx(awayAngle), taken);
    }
  }
  for (let i = 0; i < stops.length; i++) {
    if (dirs[i] === null) dirs[i] = angleToIdx(repulsion[i]);
  }

  const out = new Map<string, LabelAnchor>();
  for (let i = 0; i < stops.length; i++) out.set(stops[i].id, DIRS[dirs[i] as number]);
  return out;
}

// 22 real Vilnius Old Town stops — the prototype's visual fixture.
const VILNIUS: GtfsStop[] = [
  stop("s0", "Vinco Kudirkos a.", 54.6887, 25.2798),
  stop("s1", "Vinco Kudirkos a.", 54.6877, 25.2798),
  stop("s2", "Lukiškių a.", 54.6896, 25.2726),
  stop("s3", "Lukiškių a.", 54.6889, 25.2721),
  stop("s4", "Seimo rūmai", 54.69, 25.2681),
  stop("s5", "Seimo rūmai", 54.6893, 25.2677),
  stop("s6", "Žaliasis tiltas", 54.6926, 25.2806),
  stop("s7", "Žaliasis tiltas", 54.6924, 25.28),
  stop("s8", "K. Mindaugo tiltas", 54.6882, 25.289),
  stop("s9", "K. Mindaugo tiltas", 54.6886, 25.2873),
  stop("s10", "K. Mindaugo tiltas", 54.6887, 25.2865),
  stop("s11", "Žvejų st.", 54.6917, 25.289),
  stop("s12", "Žvejų st.", 54.6901, 25.2887),
  stop("s13", "Pylimo st.", 54.6868, 25.2805),
  stop("s14", "Pylimo st.", 54.6863, 25.2812),
  stop("s15", "Halės turgus", 54.6865, 25.282),
  stop("s16", "Totorių st.", 54.686, 25.2785),
  stop("s17", "Totorių st.", 54.6857, 25.279),
  stop("s18", "Katedros a.", 54.6855, 25.2872),
  stop("s19", "Arkikatedra", 54.6857, 25.2878),
  stop("s20", "Vilniaus st.", 54.6848, 25.2818),
  stop("s21", "Vilniaus st.", 54.6845, 25.2823),
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sameLogicalStop", () => {
  it("matches identical names", () => {
    expect(sameLogicalStop("Halės turgus", "Halės turgus")).toBe(true);
  });
  it("matches names differing only by a trailing number", () => {
    expect(sameLogicalStop("Stop 01", "Stop 02")).toBe(true);
    expect(sameLogicalStop("Platform 7", "Platform 12")).toBe(true);
  });
  it("rejects distinct names", () => {
    expect(sameLogicalStop("Totorių st.", "Pylimo st.")).toBe(false);
  });
  it("rejects when stripping leaves nothing", () => {
    expect(sameLogicalStop("01", "02")).toBe(false);
  });
});

describe("pairRadius", () => {
  it("returns the extended radius for same logical stops", () => {
    expect(pairRadius({ name: "Stop 01" }, { name: "Stop 02" })).toBeCloseTo(0.003);
  });
  it("returns the base radius for unrelated stops", () => {
    expect(pairRadius({ name: "A" }, { name: "B" })).toBeCloseTo(0.0012);
  });
});

describe("computeLabelAnchors", () => {
  it("returns an empty map for no stops", () => {
    expect(computeLabelAnchors([]).size).toBe(0);
  });

  it("anchors a fully isolated stop to the right", () => {
    const anchors = computeLabelAnchors([stop("a", "Lonely", 50, 10)]);
    expect(anchors.get("a")).toBe("right");
  });

  it("gives a same-name cross-street pair opposing anchors", () => {
    // Two platforms of one stop ~110 m apart north/south (within EXTENDED_R).
    const a = stop("a", "Cathedral Sq", 54.685, 25.28);
    const b = stop("b", "Cathedral Sq", 54.686, 25.28);
    const anchors = computeLabelAnchors([a, b]);
    const da = anchors.get("a")!;
    const db = anchors.get("b")!;
    expect(db).toBe(OPPOSITE[da]);
    // b is north of a, so b's label goes up and a's goes down.
    expect(db).toBe("top");
    expect(da).toBe("bottom");
  });

  it("pushes a pure pair of unrelated stops apart", () => {
    // ~90 m apart east/west, within BASE_R, no other neighbors.
    const a = stop("a", "Market", 54.685, 25.28);
    const b = stop("b", "Town Hall", 54.685, 25.2812);
    const anchors = computeLabelAnchors([a, b]);
    expect(anchors.get("a")).toBe("left"); // a is west → label west
    expect(anchors.get("b")).toBe("right"); // b is east → label east
  });

  it("spreads a tight 3-stop cluster across distinct directions", () => {
    const a = stop("a", "Alpha", 54.685, 25.28);
    const b = stop("b", "Beta", 54.6858, 25.28);
    const c = stop("c", "Gamma", 54.6854, 25.2807);
    const anchors = computeLabelAnchors([a, b, c]);
    const set = new Set([anchors.get("a"), anchors.get("b"), anchors.get("c")]);
    expect(set.size).toBe(3);
  });

  it("is deterministic across repeated runs", () => {
    const first = computeLabelAnchors(VILNIUS);
    const second = computeLabelAnchors(VILNIUS);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("matches the brute-force reference on the Vilnius fixture (grid equivalence)", () => {
    const grid = computeLabelAnchors(VILNIUS);
    const ref = bruteForce(VILNIUS);
    expect([...grid.entries()].sort()).toEqual([...ref.entries()].sort());
  });

  it("matches the brute-force reference on a randomized dense cluster", () => {
    // Deterministic LCG so the case is reproducible.
    let seed = 0x1234abcd;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0xffffffff;
    };
    const stops: GtfsStop[] = [];
    for (let i = 0; i < 400; i++) {
      stops.push(
        stop(`r${i}`, `Name ${i % 30}`, 54.68 + rnd() * 0.01, 25.27 + rnd() * 0.01),
      );
    }
    const grid = computeLabelAnchors(stops);
    const ref = bruteForce(stops);
    expect([...grid.entries()].sort()).toEqual([...ref.entries()].sort());
  });

  it("computes valid anchors for ~60k stops", () => {
    const stops: GtfsStop[] = [];
    let seed = 99;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0xffffffff;
    };
    // ~60k stops spread over a city-sized box (so the grid stays sparse). Names
    // end in a letter so `sameLogicalStop`'s trailing-number strip does NOT
    // collapse them into one logical stop (which would make every pair use the
    // EXTENDED radius — a degenerate all-neighbors case, not realistic data).
    for (let i = 0; i < 60_000; i++) {
      const tag = String.fromCharCode(97 + (i % 26));
      stops.push(
        stop(`p${i}`, `Stop ${i} ${tag}`, 48.8 + rnd() * 0.3, 2.2 + rnd() * 0.4),
      );
    }
    const anchors = computeLabelAnchors(stops);
    expect(anchors.size).toBe(60_000);
    expect(stops.every((s) => DIRS.includes(anchors.get(s.id)!))).toBe(true);
    // This is a large-feed smoke test, not a wall-clock benchmark: shared CI
    // runner load varies. The suite timeout still bounds runaway execution.
  });
});
