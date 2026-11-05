import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

interface OsrmPreprocessConfig {
  /** Path to OSM PBF extract for the city */
  osmPbfPath: string;
  /** Output directory for OSRM files */
  outputDir: string;
  /** City identifier */
  cityId: string;
  /** Path to OSRM foot profile (default: foot.lua from osrm-backend) */
  profilePath?: string;
}

/**
 * Run OSRM extract + contract pipeline for a city's pedestrian network.
 *
 * Requires osrm-backend to be installed (osrm-extract, osrm-contract).
 * Uses the default foot profile unless overridden.
 *
 * Produces .osrm, .osrm.hsgr, .osrm.fileIndex, etc. in the output directory.
 */
export function preprocessOsrm(config: OsrmPreprocessConfig): void {
  const { osmPbfPath, outputDir, cityId, profilePath } = config;

  if (!existsSync(osmPbfPath)) {
    throw new Error(`OSM PBF not found: ${osmPbfPath}`);
  }

  mkdirSync(outputDir, { recursive: true });

  const profile = profilePath ?? "/usr/share/osrm/profiles/foot.lua";
  const osrmFile = path.join(outputDir, `${cityId}.osrm`);

  // Step 1: Extract — parse OSM data with foot profile
  console.log(`[osrm] Extracting ${osmPbfPath} with foot profile...`);
  execFileSync("osrm-extract", ["-p", profile, osmPbfPath, "--output", osrmFile], {
    stdio: "inherit",
  });

  // Step 2: Contract — build contraction hierarchy for fast queries
  console.log(`[osrm] Contracting ${osrmFile}...`);
  execFileSync("osrm-contract", [osrmFile], {
    stdio: "inherit",
  });

  console.log(`[osrm] Done. OSRM files at ${outputDir}/${cityId}.*`);
}

// CLI entry point
const scriptName = process.argv[1] ?? "";
if (scriptName.endsWith("osrmPreprocess.ts") || scriptName.endsWith("osrmPreprocess.js")) {
  const [, , osmPbfPath, outputDir, cityId] = process.argv;
  if (!osmPbfPath || !outputDir || !cityId) {
    console.error("Usage: osrmPreprocess <osmPbfPath> <outputDir> <cityId>");
    process.exit(1);
  }
  preprocessOsrm({ osmPbfPath, outputDir, cityId });
}
