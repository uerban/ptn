import {
  PATTERN_MODE,
  PatternMode,
} from "@pt/shared/raptor";

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface PtbCatalogGeneration {
  generationId: string;
  /** PTB content hash; the `/raptor-bundle` ETag carries it. */
  bundleSha256: string;
  generatedAt: string;
  cityTzIana: string;
  shapesArtifact?: { url: string; hash: string; sizeBytes: number };
}

interface ReadyBody {
  status?: unknown;
  city?: unknown;
  servingGenerationId?: unknown;
  servingBundleSha256?: unknown;
  generationAgeSecs?: unknown;
  cityTzIana?: unknown;
  servingShapesJsonSha256?: unknown;
  servingShapesJsonSizeBytes?: unknown;
  nowUnixSecs?: unknown;
  patternMode?: unknown;
}

/** Validate the Rust `/ready` fields needed to pair PTB bytes with sidecars. */
export function parsePtbCatalogGeneration(
  input: ReadyBody,
  expectedCity: string,
  expectedMode: PatternMode = PATTERN_MODE,
): PtbCatalogGeneration {
  if (input.status !== "ready") throw new Error("ptb catalog: pt-serve is not ready");
  if (input.city !== expectedCity) {
    throw new Error(`ptb catalog: ready city mismatch (${String(input.city)} != ${expectedCity})`);
  }
  if (input.patternMode !== expectedMode) {
    throw new Error(
      `ptb catalog: pattern mode mismatch (${String(input.patternMode)} != ${expectedMode})`,
    );
  }
  if (typeof input.servingGenerationId !== "string" || !SHA256_RE.test(input.servingGenerationId)) {
    throw new Error("ptb catalog: invalid servingGenerationId");
  }
  // Timetable bytes and OSM sidecars version independently: the publication
  // id binds both, the PTB hash only the timetable. A pt-serve that predates
  // the field serves generation ids equal to the PTB hash.
  const bundleSha256 = input.servingBundleSha256 ?? input.servingGenerationId;
  if (typeof bundleSha256 !== "string" || !SHA256_RE.test(bundleSha256)) {
    throw new Error("ptb catalog: invalid servingBundleSha256");
  }
  if (typeof input.cityTzIana !== "string" || input.cityTzIana.length === 0) {
    throw new Error("ptb catalog: missing cityTzIana");
  }
  if (
    typeof input.nowUnixSecs !== "number" || !Number.isFinite(input.nowUnixSecs) ||
    typeof input.generationAgeSecs !== "number" || !Number.isFinite(input.generationAgeSecs) ||
    input.generationAgeSecs < 0
  ) {
    throw new Error("ptb catalog: invalid generation age provenance");
  }

  const generatedUnixSecs = Math.max(0, input.nowUnixSecs - input.generationAgeSecs);
  const generatedAt = new Date(generatedUnixSecs * 1000).toISOString();

  const hash = input.servingShapesJsonSha256;
  const size = input.servingShapesJsonSizeBytes;
  let shapesArtifact: PtbCatalogGeneration["shapesArtifact"];
  if (hash === null && size === null) {
    shapesArtifact = undefined;
  } else if (
    typeof hash === "string" && SHA256_RE.test(hash) &&
    typeof size === "number" && Number.isSafeInteger(size) && size >= 0
  ) {
    shapesArtifact = {
      url: `/api/${expectedCity}/gtfs/shapes/shapes-${hash}.json`,
      hash,
      sizeBytes: size,
    };
  } else {
    // Requiring the pair makes a rolling deployment fail safely until every
    // pt-serve replica exposes the complete shapes provenance.
    throw new Error("ptb catalog: incomplete shapes provenance");
  }

  return {
    generationId: input.servingGenerationId,
    bundleSha256,
    generatedAt,
    cityTzIana: input.cityTzIana,
    ...(shapesArtifact ? { shapesArtifact } : {}),
  };
}

export async function fetchPtbCatalogGeneration(cityId: string): Promise<PtbCatalogGeneration> {
  const response = await fetch(`/api/${cityId}/ready`, { cache: "no-store" });
  if (!response.ok) throw new Error(`ptb catalog: ready HTTP ${response.status}`);
  return parsePtbCatalogGeneration(await response.json() as ReadyBody, cityId);
}
