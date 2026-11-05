import {
  type RoutingBundleData,
  type RoutingBundleTransfersArtifact,
} from "@pt/shared";
import { RAPTOR_DATA_VERSION } from "@pt/shared/constants";
import { PATTERN_MODE, PatternMode } from "@pt/shared/raptor";
import { loadPtb, ptbBundleToWire } from "@pt/shared/ptb";
import type { PtbCatalogGeneration } from "./ptbCatalog.ts";

export interface DecodePtbCatalogOptions {
  cityId: string;
  generation: PtbCatalogGeneration;
  transfersArtifact?: RoutingBundleTransfersArtifact;
  patternMode?: PatternMode;
}

/** Decode the Rust-produced PTB into the existing frontend catalog wire shape. */
export function decodePtbCatalog(
  bytes: Uint8Array,
  options: DecodePtbCatalogOptions,
): RoutingBundleData {
  const wire = ptbBundleToWire(
    loadPtb(bytes),
    options.patternMode ?? PATTERN_MODE,
    { includeDirectionPatterns: true },
  );
  return {
    ...wire,
    // This is the JSON catalog schema version, not the PTB file-format version.
    version: RAPTOR_DATA_VERSION,
    meta: {
      generatedAt: options.generation.generatedAt,
      cityId: options.cityId,
      cityTzIana: options.generation.cityTzIana,
      ...(options.generation.shapesArtifact
        ? { shapesArtifact: options.generation.shapesArtifact }
        : {}),
      ...(options.transfersArtifact
        ? { transfersArtifact: options.transfersArtifact }
        : {}),
    },
  };
}
