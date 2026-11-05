// Extraction step for the local address-search corpus (crates/pt-geocode).
//
// Emits the JSON INTERMEDIATE, stamped with
// ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION — a contract of its own, distinct from
// the packed artifact's version. That JSON is not what ships and is not
// committed; pack it first:
//   pt-producer pack-address-search --input <out.json> --out <out.fst> --city <slug>
//
// The image build runs it through scripts/build-city-osm-artifacts.mjs; by hand:
//   pnpm --filter @pt/shared build
//   npx tsx packages/backend/scripts/extract-addr-fixture.ts <pbf> <minLon> <minLat> <maxLon> <maxLat> <out.json> [cityId]
//
// Reuses runOsmiumExport's bbox filter + node/way/relation centroid
// resolution (same code path production POI bundles use) but filters on
// addr:housenumber instead of the POI tag spec.
import { writeFile } from "node:fs/promises";
import {
  ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION,
  buildAddressSearchKeys,
  type AddressSearchArtifact,
  type AddressSearchKey,
  type AddressSearchRow,
} from "@pt/shared/address-search";
import { runOsmiumExport } from "../src/poi/osmiumExtract.js";

function displayLabel(street: string, housenumber: string): string {
  return `${street} ${housenumber}`.replace(/\s+/g, " ").trim();
}

const STREET_ALIAS_TAGS = ["name:en", "name:ru", "int_name"];
const ADDRESS_ALIAS_TAGS = ["addr:street:en", "addr:street:ru"];

async function main() {
  const [pbf, minLon, minLat, maxLon, maxLat, out, cityId] = process.argv.slice(2);
  if (!pbf || !minLon || !minLat || !maxLon || !maxLat || !out) {
    console.error(
      "usage: extract-addr-fixture.ts <pbf> <minLon> <minLat> <maxLon> <maxLat> <out.json> [cityId]",
    );
    process.exit(1);
  }

  const bbox = {
    minLon: Number(minLon),
    minLat: Number(minLat),
    maxLon: Number(maxLon),
    maxLat: Number(maxLat),
  };

  const rows: AddressSearchRow[] = [];
  const keys: AddressSearchKey[] = [];
  const rowIdByLabel = new Map<string, number>();
  // Extra spellings per row: addr:street:<lang> on the address itself, and
  // the name:<lang> / int_name of any highway carrying the street's name.
  // Without them a city whose OSM names are in a non-Latin script (tbilisi)
  // has no searchable keys at all.
  const rowStreet: { street: string; housenumber: string; extra: Set<string> }[] = [];
  const streetAliases = new Map<string, Set<string>>();
  let rawFeatureCount = 0;
  let skippedNoStreet = 0;
  let omittedNoLetters = 0;

  for await (const feature of runOsmiumExport(pbf, { bbox })) {
    const t = feature.tags;
    if (t.highway && t.name) {
      for (const k of STREET_ALIAS_TAGS) {
        const alias = t[k];
        if (!alias || alias === t.name) continue;
        let set = streetAliases.get(t.name);
        if (!set) streetAliases.set(t.name, (set = new Set()));
        set.add(alias);
      }
    }
    const housenumber = t["addr:housenumber"];
    if (!housenumber) continue;
    rawFeatureCount++;

    const street = t["addr:street"];
    if (!street) {
      skippedNoStreet++;
      continue;
    }

    // Dedup on the exact display label, NOT a normalized/transliterated
    // search key: two distinct addresses can normalize to the same key (e.g.
    // inconsistent diacritic tagging), and deduping on that would silently
    // discard the second feature's own coordinates while still indexing its
    // keys against the first feature's row.
    const label = displayLabel(street, housenumber);
    let rowId = rowIdByLabel.get(label);
    if (rowId === undefined) {
      rowId = rows.length;
      rowIdByLabel.set(label, rowId);
      rows.push({ label, lat: feature.lat, lon: feature.lon });
      rowStreet.push({ street, housenumber, extra: new Set() });
    }
    for (const k of ADDRESS_ALIAS_TAGS) {
      if (t[k]) rowStreet[rowId].extra.add(displayLabel(t[k], housenumber));
    }
  }

  const keptRows: AddressSearchRow[] = [];
  rows.forEach((row, i) => {
    const { street, housenumber, extra } = rowStreet[i];
    const labels = new Set([row.label, ...extra]);
    for (const alias of streetAliases.get(street) ?? []) labels.add(displayLabel(alias, housenumber));
    // The normalizer keeps only [a-z0-9]; a key with no letter left is a bare
    // house number that would match every street, so it is dropped.
    const rowKeys = new Set<string>();
    for (const l of labels) for (const key of buildAddressSearchKeys(l)) if (/[a-z]/.test(key)) rowKeys.add(key);
    if (rowKeys.size === 0) {
      omittedNoLetters++;
      return;
    }
    const rowId = keptRows.length;
    keptRows.push(row);
    for (const key of rowKeys) keys.push({ key, rowId });
  });

  const dedupedKeys = new Map<string, AddressSearchKey>();
  for (const key of keys) {
    dedupedKeys.set(`${key.key}\0${key.rowId}`, key);
  }

  const artifact: AddressSearchArtifact = {
    schemaVersion: ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION,
    ...(cityId ? { cityId } : {}),
    source: pbf,
    generatedAt: new Date().toISOString(),
    rows: keptRows,
    keys: [...dedupedKeys.values()].sort(
      (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.rowId - b.rowId,
    ),
    stats: {
      rawFeatureCount,
      rowCount: keptRows.length,
      keyCount: dedupedKeys.size,
      skippedNoStreet,
      omittedNoLetters,
    },
  };

  await writeFile(out, JSON.stringify(artifact));
  console.log(JSON.stringify(artifact.stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
