#!/usr/bin/env tsx
/**
 * PTN City Harness CLI Runner
 *
 * Runs the routing engine evaluation harness against one or more cities.
 * Outputs results as formatted tables (default) or JSON (--json).
 *
 * Usage:
 *   pnpm --filter @pt/backend harness                       # All cities, all adapters
 *   pnpm --filter @pt/backend harness -- --city vilnius      # Single city (use --list-cities to see all)
 *   pnpm --filter @pt/backend harness -- --json              # JSON output
 *   pnpm --filter @pt/backend harness -- --city vilnius --json > results.json
 */
import { createAdapterRegistry } from "../adapters/registry.js";
import {
  runCityHarness,
  formatCityHarnessResult,
} from "../adapters/benchmark.js";
import { cityProfiles, listCityIds, getCityProfile } from "./cities/index.js";
import type { CityHarnessResult } from "@pt/shared";

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const cityArg = getArgValue(args, "--city");
  const adapterArg = getArgValue(args, "--adapter");

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  if (args.includes("--list-cities")) {
    console.log("Available cities:");
    for (const id of listCityIds()) {
      const p = cityProfiles[id];
      console.log(`  ${id.padEnd(12)} ${p.name}, ${p.country} (${p.scenarios.length} scenarios, ${p.landmarks.length} landmarks)`);
    }
    return;
  }

  // Resolve cities
  const targetCities = cityArg
    ? [getCityProfile(cityArg)].filter(Boolean)
    : Object.values(cityProfiles);

  if (targetCities.length === 0) {
    console.error(`Unknown city: "${cityArg}". Use --list-cities to see available options.`);
    process.exit(1);
  }

  // Resolve adapters
  const registry = createAdapterRegistry();
  const targetAdapters = adapterArg
    ? [registry.get(adapterArg)].filter(Boolean)
    : registry.all();

  if (targetAdapters.length === 0) {
    console.error(`Unknown adapter: "${adapterArg}". Available: ${registry.list().join(", ")}`);
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log(`PTN City Harness`);
    console.log(`Cities: ${targetCities.map((c) => c!.name).join(", ")}`);
    console.log(`Adapters: ${targetAdapters.map((a) => a!.name).join(", ")}`);
    console.log("");
  }

  const allResults: CityHarnessResult[] = [];

  for (const city of targetCities) {
    for (const adapter of targetAdapters) {
      if (!jsonOutput) {
        console.log(`Running ${city!.name} against ${adapter!.name}...`);
      }

      const result = await runCityHarness(adapter!, city!);
      allResults.push(result);

      if (!jsonOutput) {
        console.log(formatCityHarnessResult(result));
        console.log("");
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
  }

  // Exit with error if any health check failed
  const anyUnhealthy = allResults.some((r) => !r.healthCheck.healthy);
  if (anyUnhealthy) {
    if (!jsonOutput) {
      console.error("WARNING: One or more adapters failed health check.");
    }
    process.exit(1);
  }
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function printUsage() {
  console.log(`
PTN City Harness — Routing Engine Evaluation Tool

Usage:
  pnpm --filter @pt/backend harness [options]

Options:
  --city <id>       Run harness for a single city (use --list-cities to enumerate)
  --adapter <name>  Test a single adapter (e.g., motis, otp, navitia)
  --json            Output results as JSON (for CI or further processing)
  --list-cities     List all available city profiles
  --help, -h        Show this help message

Examples:
  pnpm --filter @pt/backend harness
      Run all cities against all adapters, table output.

  pnpm --filter @pt/backend harness -- --city vilnius
      Run Vilnius scenarios against all adapters.

  pnpm --filter @pt/backend harness -- --city oslo --json
      Run Oslo scenarios, output as JSON.

  pnpm --filter @pt/backend harness -- --city paris --adapter motis --json > results/paris-motis.json
      Single city + adapter, save JSON to file.

Environment:
  MOTIS_URL         Override MOTIS/Transitous base URL
                    (default: https://api.transitous.org/api)
`);
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
