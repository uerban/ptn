import type {
  GeocoderAdapter,
  GeocoderCandidate,
  LatLon,
  PrivacyTier,
} from "@pt/shared";
import { GeocoderStatusEmitter } from "./statusEvents.ts";

const TIER_ORDER: Record<PrivacyTier, number> = {
  local: 0,
  "self-hosted": 1,
  "third-party": 2,
};

export class GeocoderRegistry {
  readonly status = new GeocoderStatusEmitter();
  private readonly registered: GeocoderAdapter[] = [];
  private forwardToken = 0;
  private reverseToken = 0;

  /** Accessor for the active city's resolved POI fetch mode. Injected by
   *  bootPoi.ts at boot (NOT a constructor import — that would form the
   *  instance.ts → poiFetchMode.ts → registerSelfHosted.ts → instance.ts cycle;
   *  Must-fix 2). Defaults to a no-op (never server-side) so the zero-arg
   *  constructor and all legacy callers/tests keep today's behaviour. */
  private activeMode: () => string = () => "eager-bundle";

  /**
 * Inject the active-mode accessor. Called once from bootPoi.ts. Side-effect free read; only
 * consulted at forward/reverse time.
 */
  setActiveModeAccessor(fn: () => string): void {
    this.activeMode = fn;
  }

  register(adapter: GeocoderAdapter): void {
    this.registered.push(adapter);
    this.registered.sort(
      (a, b) => TIER_ORDER[a.privacyTier] - TIER_ORDER[b.privacyTier],
    );
  }

  unregister(id: string): void {
    const idx = this.registered.findIndex((a) => a.id === id);
    if (idx !== -1) this.registered.splice(idx, 1);
  }

  adapters(): readonly GeocoderAdapter[] {
    return this.registered;
  }

  async forward(
    query: string,
    hint: LatLon | null,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate[]> {
    const token = ++this.forwardToken;

    // Computed ONCE per query (NOT per-adapter): activeMode() does a settings
    // read + a CITIES linear scan; calling it inside the loop is hot-path waste
    // (Must-fix 3).
    const serverSide = this.activeMode() === "server-side";

    for (const adapter of this.registered) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (!(await adapter.isAvailable())) continue;

      // Under EXPLICIT server-side mode, gate the on-device tiers so neither a stale local corpus
      // shadows the server ("first non-empty wins") NOR a third-party geocoder leaks the query. The
      // self-hosted tier is the ONLY tier consulted while server-side. (Address augmentation under
      // a LOCAL mode does NOT use this tier-walk — it calls forwardSelfHosted directly;.) Adapters
      // stay registered (cheap re-enable on flip-back).
      if (serverSide && (adapter.privacyTier === "local" || adapter.privacyTier === "third-party")) {
        continue;
      }

      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      let results: GeocoderCandidate[];
      try {
        results = await adapter.forward(query, hint, signal);
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          throw err;
        }
        this.status.emit({
          kind: "provider-failed",
          provider: adapter.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }

      if (token !== this.forwardToken) return [];
      // Unconditional-on-success recovery signal for the self-hosted tier: emit on EVERY successful
      // self-hosted forward (not only failure→ success). Stateless; the chip no-ops when not
      // currently failed. Single emit site shared with forwardSelfHosted — never duplicated in
      // callers.
      if (adapter.privacyTier === "self-hosted") {
        this.status.emit({ kind: "provider-recovered", provider: adapter.id });
      }
      if (results.length > 0) return results;
    }

    return [];
  }

  /**
 * Self-hosted-tier-only forward. Augmentation under a LOCAL mode must NOT use the tier-walking
 * `forward` — that would (a) leak the query to a third-party adapter and (b) let a non-empty
 * local tier shadow the addresses. Reuses `forward`'s try/catch/emit/isAvailable body
 * restricted to the registered self-hosted adapter, applying its live coarsening closure. OMITS
 * the forwardToken staleness guard (the shared per-invocation AbortController supersedes a
 * stale query at the stream level).
 */
  async forwardSelfHosted(
    query: string,
    hint: LatLon | null,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate[]> {
    const adapter = this.registered.find((a) => a.privacyTier === "self-hosted");
    if (!adapter) return [];

    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!(await adapter.isAvailable())) return [];

    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    let results: GeocoderCandidate[];
    try {
      results = await adapter.forward(query, hint, signal);
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        throw err;
      }
      this.status.emit({
        kind: "provider-failed",
        provider: adapter.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    // Unconditional-on-success recovery emit, single site shared with forward.
    this.status.emit({ kind: "provider-recovered", provider: adapter.id });
    return results;
  }

  async reverse(
    coord: LatLon,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate | null> {
    const token = ++this.reverseToken;

    // Computed ONCE per query (NOT per-adapter): activeMode() does a settings
    // read + a CITIES linear scan; calling it inside the loop is hot-path waste
    // (Must-fix 3).
    const serverSide = this.activeMode() === "server-side";

    for (const adapter of this.registered) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (!(await adapter.isAvailable())) continue;

      // Symmetric server-side gate (reverse). Under a LOCAL mode this is inactive, so the
      // always-first local adapter answers map-tap reverse first — the documented local-first
      // posture. Not an augmentation path.
      if (serverSide && (adapter.privacyTier === "local" || adapter.privacyTier === "third-party")) {
        continue;
      }

      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      let result: GeocoderCandidate | null;
      try {
        result = await adapter.reverse(coord, signal);
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          throw err;
        }
        this.status.emit({
          kind: "provider-failed",
          provider: adapter.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }

      if (token !== this.reverseToken) return null;
      if (adapter.privacyTier === "self-hosted") {
        this.status.emit({ kind: "provider-recovered", provider: adapter.id });
      }
      if (result !== null) return result;
    }

    return null;
  }
}
