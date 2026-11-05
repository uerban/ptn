#!/usr/bin/env node
// Stage C color-provenance: read a staged PTB, run the backend's existing
// clusterRouteColors + computePalettes verbatim, emit color-config.json +
// route-styles.json into the staging dir. Prints one "<name> <sha256> <bytes>"
// line per artifact to stdout (the Rust producer parses these into the manifest).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadPtb, routeTypeToMode } from "@pt/shared";
import { clusterRouteColors } from "../dist/gtfs/colorClustering.js";
import { computePalettes } from "../dist/gtfs/colorblindPalettes.js";
import { computeLabelAnchors } from "../dist/gtfs/labelAnchors.js";

// Mirrors store.ts contrastTextColor (WCAG relative luminance, 0.179 cutoff).
// No mechanical link to store.ts's private copy — the pt-serve-route-parity gate enforces sync.
function contrastTextColor(hex) {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) return "#ffffff";
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.179 ? "#000000" : "#ffffff";
}

function emit(stagingDir, name, bodyStr) {
  const buf = Buffer.from(bodyStr, "utf8");
  writeFileSync(join(stagingDir, name), buf);
  const sha = createHash("sha256").update(buf).digest("hex");
  process.stdout.write(`${name} ${sha} ${buf.length}\n`);
}

function main() {
  const stagingDir = process.argv[2];
  if (!stagingDir) {
    process.stderr.write("usage: color-artifacts-gen.mjs <staging-dir>\n");
    process.exit(2);
  }
  const bundle = loadPtb(readFileSync(join(stagingDir, "bundle.ptb")));
  const routeInputs = bundle.routes.map((r) => ({
    id: r.routeId,
    shortName: r.routeShortName,
    color: r.routeColor, // 6-hex no '#', or "" when omitted
    mode: routeTypeToMode(r.routeType),
  }));

  const { subModes, routeSubModeMap } = clusterRouteColors(routeInputs);
  const subModeById = new Map(subModes.map((sm) => [sm.id, sm]));
  const baseColors = Object.fromEntries(subModes.map((sm) => [sm.id, sm.color]));
  const { light, dark, universalLimited } = computePalettes(baseColors);

  // color-config.json — byte-identical to the backend /color-config body.
  const colorConfig = { modes: subModes, palettes: { light, dark }, universalLimited };
  emit(stagingDir, "color-config.json", JSON.stringify(colorConfig));

  // route-styles.json — { "<routeId>": { color, textColor, subMode } } —
  // exactly the per-route resolution store.ts getAllStops/getNearbyStops does.
  const routeStyles = {};
  for (const r of routeInputs) {
    const sm = routeSubModeMap.get(r.id);
    const entry = subModeById.get(sm ?? "");
    const normalized = entry?.color ?? (r.color ? `#${r.color}` : "");
    routeStyles[r.id] = {
      color: normalized.replace(/^#/, ""),
      textColor: contrastTextColor(normalized) === "#000000" ? "000000" : "FFFFFF",
      subMode: sm ?? r.mode,
    };
  }
  emit(stagingDir, "route-styles.json", JSON.stringify(routeStyles));

  // label-anchors.json — per-stop GL label anchor via the EXACT backend solver,
  // over stops in PTB order (== canonical.iterStops order on the backend) so
  // pt-serve serves labelAnchor verbatim and parity holds. Do NOT reorder stops.
  // loadPtb yields PtbStop ({stopId,stopName,stopLat,stopLon}); map to the
  // {id,name,lat,lon} shape computeLabelAnchors reads — the same field mapping
  // loadFromPtb's synthStops applies before canonical.iterStops feeds the solver.
  const anchorStops = bundle.stops.map((s) => ({
    id: s.stopId,
    name: s.stopName,
    lat: s.stopLat,
    lon: s.stopLon,
    parentStation: "",
  }));
  const anchors = computeLabelAnchors(anchorStops);
  emit(stagingDir, "label-anchors.json", JSON.stringify(Object.fromEntries(anchors)));
}

main();
