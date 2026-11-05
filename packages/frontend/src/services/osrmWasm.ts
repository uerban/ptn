import type { LatLon } from "@pt/shared";

interface OsrmTableResult {
  /** Duration matrix in seconds. durations[source][destination]. -1 = unreachable. */
  durations: number[][];
}

/**
 * OSRM WASM client for in-browser pedestrian routing.
 *
 * POC implementation: loads OSRM WASM + city graph data, provides
 * table (many-to-many) queries. Walk-leg paths come from the walk graph
 * (walkGraphClient.ts), not from here.
 *
 * The actual WASM package does not exist on npm yet. This class provides
 * the integration seam (types, loader, client interface) so the rest of the
 * routing pipeline can be built and tested against it. In production, the
 * dynamic import would resolve to whichever package becomes available
 * (e.g., "osrm-wasm", "@project-osrm/osrm.js", or a custom build).
 *
 * Limitations (accepted for POC):
 * - Single foot profile (no stroller/wheelchair variants)
 * - No native isochrone support (approximated via table queries)
 * - Graph data must be fully downloaded before queries work
 */
export class OsrmWasmClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OSRM WASM module type unknown until real package available
  private osrm: any = null;
  private ready = false;
  private loading = false;

  // Module-scoped flag (via static) so the "disabled" message logs at
  // most once per app load, even with multiple OsrmWasmClient instances.
  // Surfaces env-var typos (e.g. VITE_OSRM_WASM_ENABLE without the D)
  // without spamming the console on every search.
  private static disabledLogged = false;
  private static logDisabledOnce(): void {
    if (OsrmWasmClient.disabledLogged) return;
    OsrmWasmClient.disabledLogged = true;
    console.info(
      "[osrm-wasm] disabled — set VITE_OSRM_WASM_ENABLED=true to enable. " +
        "Search will use the radius-fallback path.",
    );
  }

  /**
   * Load OSRM WASM module and city graph data.
   * Call once per city. Safe to call multiple times (no-op if already loaded).
   */
  async init(cityId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    // Build-time kill switch — see class JSDoc above for the integration
    // seam. Explicit `=== "true"` (rather than truthy-check) so that env
    // values like `"0"`, `"off"`, `"no"` correctly disable the path
    // instead of silently enabling it. Anyone who wants WASM must set
    // VITE_OSRM_WASM_ENABLED=true exactly.
    if (import.meta.env.VITE_OSRM_WASM_ENABLED !== "true") {
      OsrmWasmClient.logDisabledOnce();
      return;
    }

    if (this.ready || this.loading) return;
    this.loading = true;

    try {
      // Dynamic import of OSRM WASM module.
      // The actual package name will depend on what's available:
      //   - "osrm-wasm" (hypothetical npm package)
      //   - "@project-osrm/osrm.js" (hypothetical official build)
      //   - A custom Emscripten build of libosrm
      // This is the integration seam; the specific import is resolved at build time.
      // Variable prevents Vite's import analysis from resolving the module
      // at transform time (the package doesn't exist on npm yet).
      const mod = "osrm-wasm";
      const OSRM = await import(/* @vite-ignore */ mod);

      // Fetch the city's OSRM data files from the backend static endpoint.
      // F9: the caller keys the signal to the city/init generation so a city
      // switch mid-download aborts the multi-MB graph fetch.
      const dataUrl = `/api/osrm/${cityId}.osrm`;
      const response = await fetch(dataUrl, { signal: opts.signal });
      if (!response.ok) throw new Error(`Failed to fetch OSRM data: ${response.status}`);
      const data = await response.arrayBuffer();

      this.osrm = new OSRM.default(new Uint8Array(data));
      this.ready = true;
    } catch (err) {
      this.loading = false;
      throw err;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Compute duration matrix from sources to destinations.
   * Used for isochrone approximation: one source (user location) to many destinations (stops).
   */
  async table(
    sources: LatLon[],
    destinations: LatLon[],
  ): Promise<OsrmTableResult | null> {
    if (!this.osrm) return null;

    try {
      const coordinates = [
        ...sources.map((s) => [s.lon, s.lat]),
        ...destinations.map((d) => [d.lon, d.lat]),
      ];

      const sourceIndices = sources.map((_, i) => i);
      const destIndices = destinations.map((_, i) => i + sources.length);

      const result = this.osrm.table({
        coordinates,
        sources: sourceIndices,
        destinations: destIndices,
      });

      return { durations: result.durations };
    } catch {
      return null;
    }
  }

  /**
   * Release OSRM resources. Call when switching cities.
   */
  destroy(): void {
    this.osrm = null;
    this.ready = false;
    this.loading = false;
  }
}

/** Singleton instance */
export const osrmClient = new OsrmWasmClient();
