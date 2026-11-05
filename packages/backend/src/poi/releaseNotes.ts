import { readdir, readFile, writeFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import { join, resolve } from "node:path";
import type { PoiBundle } from "@pt/shared";

export interface BundleSummary {
  cityId: string;
  tier: string;
  entryCount: number;
  version: string;
  sourcePbfTimestamp: string;
  bundleGeneratedAt: string;
  filename: string;
}

export function parseBundleFilename(
  filename: string,
): { cityId: string; tier: string } | null {
  const match = filename.match(/^([a-z0-9_-]+)(?:\.loose)?\.br$/);
  if (!match) return null;
  return {
    cityId: match[1],
    tier: filename.includes(".loose") ? "loose" : "strict",
  };
}

export function readBundleFromBuffer(compressed: Buffer): PoiBundle {
  const json = brotliDecompressSync(compressed).toString("utf-8");
  return JSON.parse(json) as PoiBundle;
}

export async function collectBundleSummaries(
  bundleDir: string,
): Promise<BundleSummary[]> {
  const files = await readdir(bundleDir);
  const brFiles = files.filter((f) => f.endsWith(".br")).sort();
  const summaries: BundleSummary[] = [];

  for (const filename of brFiles) {
    const parsed = parseBundleFilename(filename);
    if (!parsed) continue;

    const compressed = await readFile(join(bundleDir, filename));
    const bundle = readBundleFromBuffer(compressed);

    summaries.push({
      cityId: bundle.meta.cityId,
      tier: bundle.meta.tier,
      entryCount: bundle.meta.entryCount,
      version: bundle.meta.version,
      sourcePbfTimestamp: bundle.meta.sourcePbfTimestamp,
      bundleGeneratedAt: bundle.meta.bundleGeneratedAt,
      filename,
    });
  }

  return summaries;
}

export function formatReleaseBody(summaries: BundleSummary[]): string {
  const lines: string[] = [];

  lines.push("## POI Bundles");
  lines.push("");
  lines.push(
    "This release includes on-device POI bundles for offline geocoding.",
  );
  lines.push("");

  lines.push("| City | Tier | Entries | Bundle Hash |");
  lines.push("|------|------|---------|-------------|");
  for (const s of summaries) {
    lines.push(`| ${s.cityId} | ${s.tier} | ${s.entryCount} | ${s.version} |`);
  }
  lines.push("");

  const timestamps = new Map<string, string>();
  for (const s of summaries) {
    if (!timestamps.has(s.sourcePbfTimestamp)) {
      timestamps.set(s.sourcePbfTimestamp, s.cityId);
    }
  }

  lines.push("### Source PBF Timestamps");
  lines.push("");
  for (const [ts, city] of timestamps) {
    lines.push(`- ${ts} (first seen: ${city})`);
  }
  lines.push("");

  if (summaries.length > 0) {
    lines.push(`Bundles generated at: ${summaries[0].bundleGeneratedAt}`);
    lines.push("");
  }

  lines.push("### Attribution");
  lines.push("");
  lines.push(
    "Map data \u00a9 OpenStreetMap contributors, licensed under the [Open Data Commons Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).",
  );
  lines.push("");
  lines.push(
    "See https://www.openstreetmap.org/copyright for full attribution details.",
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  const bundleDir = process.argv[2] ?? "packages/frontend/public/poi";
  const outputFile = process.argv[3] ?? "poi-release-notes.md";
  const summaries = await collectBundleSummaries(bundleDir);
  const body = formatReleaseBody(summaries);
  await writeFile(outputFile, body);
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.(ts|js|mjs)$/, "") ===
    resolve(import.meta.filename).replace(/\.(ts|js|mjs)$/, "");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
