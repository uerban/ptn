import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  GeocoderAdapter,
  GeocoderCandidate,
  GeocoderProviderId,
  PrivacyTier,
} from "@pt/shared";
import { GeocoderRegistry } from "./registry.ts";
import type { GeocoderStatusEvent } from "./statusEvents.ts";

function makeAdapter(opts: {
  id: GeocoderProviderId;
  tier: PrivacyTier;
  forward?: (q: string, signal: AbortSignal) => Promise<GeocoderCandidate[]>;
  reverse?: (signal: AbortSignal) => Promise<GeocoderCandidate | null>;
  available?: boolean;
}): GeocoderAdapter {
  return {
    id: opts.id,
    privacyTier: opts.tier,
    isAvailable: () => opts.available ?? true,
    forward: (q, _hint, signal) =>
      opts.forward ? opts.forward(q, signal) : Promise.resolve([]),
    reverse: (_coord, signal) =>
      opts.reverse ? opts.reverse(signal) : Promise.resolve(null),
  };
}

function candidate(
  id: GeocoderProviderId,
  tier: PrivacyTier,
  label = "X",
): GeocoderCandidate {
  return { label, lat: 0, lon: 0, confidence: 1, provider: id, privacyTier: tier };
}

describe("GeocoderRegistry", () => {
  test("registers adapters in order of privacyTier (local → self-hosted → third-party)", () => {
    const reg = new GeocoderRegistry();
    reg.register(makeAdapter({ id: "third-party-mapbox", tier: "third-party" }));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted" }));
    reg.register(makeAdapter({ id: "bundled", tier: "local" }));
    const ids = reg.adapters().map((a) => a.id);
    expect(ids).toEqual(["bundled", "self-hosted", "third-party-mapbox"]);
  });

  test("forward() calls adapters in order until a non-empty result", async () => {
    const reg = new GeocoderRegistry();
    const localSpy = vi.fn(async () => []);
    const selfSpy = vi.fn(async () => [candidate("self-hosted", "self-hosted")]);
    const thirdSpy = vi.fn(async () => [candidate("third-party-mapbox", "third-party")]);
    reg.register(
      makeAdapter({ id: "bundled", tier: "local", forward: localSpy }),
    );
    reg.register(
      makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: selfSpy }),
    );
    reg.register(
      makeAdapter({ id: "third-party-mapbox", tier: "third-party", forward: thirdSpy }),
    );

    const result = await reg.forward("foo", null, new AbortController().signal);
    expect(localSpy).toHaveBeenCalledTimes(1);
    expect(selfSpy).toHaveBeenCalledTimes(1);
    expect(thirdSpy).toHaveBeenCalledTimes(0);
    expect(result).toHaveLength(1);
    expect(result[0]!.provider).toBe("self-hosted");
  });

  test("provider failure emits StatusEvent { kind: 'provider-failed', provider }", async () => {
    const reg = new GeocoderRegistry();
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    reg.register(
      makeAdapter({
        id: "bundled",
        tier: "local",
        forward: async () => {
          throw new Error("boom");
        },
      }),
    );
    await reg.forward("foo", null, new AbortController().signal);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("provider-failed");
    if (events[0]!.kind === "provider-failed") {
      expect(events[0]!.provider).toBe("bundled");
    }
  });

  test("does NOT silently cascade: after failure, returns [] and lets caller decide", async () => {
    const reg = new GeocoderRegistry();
    const thirdSpy = vi.fn(async () => [candidate("third-party-mapbox", "third-party")]);
    reg.register(
      makeAdapter({
        id: "bundled",
        tier: "local",
        forward: async () => {
          throw new Error("boom");
        },
      }),
    );
    reg.register(
      makeAdapter({
        id: "third-party-mapbox",
        tier: "third-party",
        forward: thirdSpy,
      }),
    );
    const result = await reg.forward("foo", null, new AbortController().signal);
    expect(result).toEqual([]);
    expect(thirdSpy).not.toHaveBeenCalled();
  });

  test("AbortSignal cancels in-flight and downstream calls", async () => {
    const reg = new GeocoderRegistry();
    const selfSpy = vi.fn(
      (_q: string, signal: AbortSignal) =>
        new Promise<GeocoderCandidate[]>((_, reject) => {
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const thirdSpy = vi.fn(async () => [candidate("third-party-mapbox", "third-party")]);
    reg.register(
      makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: selfSpy }),
    );
    reg.register(
      makeAdapter({ id: "third-party-mapbox", tier: "third-party", forward: thirdSpy }),
    );

    const ctrl = new AbortController();
    const promise = reg.forward("foo", null, ctrl.signal);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    await expect(promise).rejects.toThrow();
    expect(thirdSpy).not.toHaveBeenCalled();
  });

  test("query-token supersedes stale response", async () => {
    const reg = new GeocoderRegistry();
    const resolvers: Array<(v: GeocoderCandidate[]) => void> = [];
    reg.register(
      makeAdapter({
        id: "bundled",
        tier: "local",
        forward: () =>
          new Promise<GeocoderCandidate[]>((r) => {
            resolvers.push(r);
          }),
      }),
    );

    const p1 = reg.forward("A", null, new AbortController().signal);
    const p2 = reg.forward("B", null, new AbortController().signal);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1]!([candidate("bundled", "local", "B-result")]);
    resolvers[0]!([candidate("bundled", "local", "A-result")]);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([]);
    expect(r2).toHaveLength(1);
    expect(r2[0]!.label).toBe("B-result");
  });
});

describe("GeocoderRegistry.reverse", () => {
  test("reverse() tries adapters in tier order until non-null", async () => {
    const reg = new GeocoderRegistry();
    const localSpy = vi.fn(async () => null);
    const selfResult = candidate("self-hosted", "self-hosted", "Reverse");
    const selfSpy = vi.fn(async () => selfResult);
    reg.register(
      makeAdapter({ id: "bundled", tier: "local", reverse: localSpy }),
    );
    reg.register(
      makeAdapter({ id: "self-hosted", tier: "self-hosted", reverse: selfSpy }),
    );

    const result = await reg.reverse(
      { lat: 0, lon: 0 },
      new AbortController().signal,
    );
    expect(result).toBe(selfResult);
  });
});

// --- Phase 3: server-side tier gating (AC-4b, AC-4c, AC-15a) ---

const LOCAL_HIT: GeocoderCandidate = {
  label: "stale local", lat: 1, lon: 1, confidence: 0.9, provider: "bundled", privacyTier: "local",
};
const SELF_HIT: GeocoderCandidate = {
  label: "server result", lat: 2, lon: 2, confidence: 0.9, provider: "self-hosted", privacyTier: "self-hosted",
};
const THIRD_HIT: GeocoderCandidate = {
  label: "third party", lat: 3, lon: 3, confidence: 0.9, provider: "third-party-mapbox", privacyTier: "third-party",
};

/** Phase-3 adapter helper: a full-fidelity adapter whose forward/reverse return
 *  the supplied candidates. Named distinctly from the existing `makeAdapter`
 *  (which has a 2-arg forward) to avoid a redeclaration error on append. */
function serverSideAdapter(
  id: GeocoderProviderId,
  tier: PrivacyTier,
  results: GeocoderCandidate[],
): GeocoderAdapter {
  return {
    id,
    privacyTier: tier,
    isAvailable: () => true,
    forward: vi.fn(async () => results),
    reverse: vi.fn(async () => results[0] ?? null),
  };
}

describe("registry tier gating under server-side (AC-4b / AC-4c / AC-15a)", () => {
  function serverSideRegistry(): GeocoderRegistry {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "server-side");
    return reg;
  }

  test("server-side mode → self-hosted answers, the stale local tier is skipped", async () => {
    const reg = serverSideRegistry();
    reg.register(serverSideAdapter("bundled", "local", [LOCAL_HIT]));
    reg.register(serverSideAdapter("self-hosted", "self-hosted", [SELF_HIT]));
    const out = await reg.forward("q", null, new AbortController().signal);
    expect(out).toEqual([SELF_HIT]);
  });

  test("non-server-side mode (default accessor) → local answers first (unchanged behaviour)", async () => {
    const reg = new GeocoderRegistry(); // default accessor: never server-side
    reg.register(serverSideAdapter("bundled", "local", [LOCAL_HIT]));
    reg.register(serverSideAdapter("self-hosted", "self-hosted", [SELF_HIT]));
    const out = await reg.forward("q", null, new AbortController().signal);
    expect(out).toEqual([LOCAL_HIT]);
  });

  test("server-side + no self-hosted + only stale local → empty (local gated, no leak) (AC-4c-adjacent)", async () => {
    const reg = serverSideRegistry();
    reg.register(serverSideAdapter("bundled", "local", [LOCAL_HIT]));
    const out = await reg.forward("q", null, new AbortController().signal);
    expect(out).toEqual([]);
  });

  test("AC-4c: server-side suppresses third-party — self-hosted DOWN + third-party UP → [], no third-party hit", async () => {
    const reg = serverSideRegistry();
    const down: GeocoderAdapter = {
      id: "self-hosted",
      privacyTier: "self-hosted",
      isAvailable: () => true,
      forward: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
      reverse: vi.fn(async () => null),
    };
    const third = serverSideAdapter("third-party-mapbox", "third-party", [THIRD_HIT]);
    reg.register(serverSideAdapter("bundled", "local", [LOCAL_HIT]));
    reg.register(down);
    reg.register(third);
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    const out = await reg.forward("q", null, new AbortController().signal);
    // self-hosted threw → provider-failed + []; third-party is gated under
    // server-side so it is NEVER consulted (no leak); local is gated too.
    expect(out).toEqual([]);
    expect(events.some((e) => e.kind === "provider-failed" && e.provider === "self-hosted")).toBe(true);
    expect((third.forward as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("AC-4b reverse(): server-side skips the local tier on reverse too (symmetric gate)", async () => {
    const reg = serverSideRegistry();
    reg.register(serverSideAdapter("bundled", "local", [LOCAL_HIT]));
    reg.register(serverSideAdapter("self-hosted", "self-hosted", [SELF_HIT]));
    const out = await reg.reverse({ lat: 2, lon: 2 }, new AbortController().signal);
    expect(out).toEqual(SELF_HIT);
  });
});



import { geocoderRegistry } from "./instance.ts";
import {
  registerSelfHostedGeocoder,
  unregisterSelfHostedGeocoder,
} from "./registerSelfHosted.ts";
import { allowFlow, resetFlows } from "../../test-helpers/networkDecisions.ts";

describe("server-side search through the EXISTING stack (AC-4 / AC-4c / AC-16)", () => {
  beforeEach(() => {
    geocoderRegistry.setActiveModeAccessor(() => "server-side");
    unregisterSelfHostedGeocoder();
    allowFlow("operator.place-search");
  });
  afterEach(() => {
    resetFlows();
    unregisterSelfHostedGeocoder();
    geocoderRegistry.setActiveModeAccessor(() => "eager-bundle"); // restore default
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  test("AC-4: the REAL self-hosted adapter parses a mocked nominatim payload (no real server)", async () => {
    // Stub fetch to return a nominatim-shaped payload. Field names MUST match
    // what SelfHostedGeocoderAdapter.forward parses (verified in Step 0).
    const payload = [
      { display_name: "Museum, City", lat: "54.35", lon: "18.65" },
    ];
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    registerSelfHostedGeocoder({
      kind: "self-hosted", endpoint: "https://geo.example", flavor: "nominatim", multiTenant: false,
    });
    const out = await geocoderRegistry.forward("museum", null, new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalled();           // hit the network seam
    expect(out.length).toBeGreaterThan(0);          // parsed at least one candidate
    expect(out[0]!.privacyTier).toBe("self-hosted");
    expect(out[0]!.lat).toBeCloseTo(54.35, 2);
    expect(out[0]!.lon).toBeCloseTo(18.65, 2);
  });

  test("AC-4c: server-side + NO geocoder registered + empty local → [] without throwing", async () => {
    const out = await geocoderRegistry.forward("museum", null, new AbortController().signal);
    expect(out).toEqual([]);
  });

  test("AC-16: a configured-but-DOWN self-hosted adapter emits provider-failed then []", async () => {
    // fetch rejects → the real adapter's forward throws → registry emits
    // provider-failed and returns []. Distinguishable from a genuine no-match.
    const fetchSpy = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    vi.stubGlobal("fetch", fetchSpy);
    registerSelfHostedGeocoder({
      kind: "self-hosted", endpoint: "https://geo.example", flavor: "nominatim", multiTenant: false,
    });
    const events: GeocoderStatusEvent[] = [];
    // GeocoderStatusEmitter exposes subscribe(listener): () => void (verified in
    // statusEvents.ts) — NOT `on`. Use the exact method name.
    geocoderRegistry.status.subscribe((e) => events.push(e));
    const out = await geocoderRegistry.forward("museum", null, new AbortController().signal);
    expect(out).toEqual([]);
    expect(events.some((e) => e.kind === "provider-failed" && e.provider === "self-hosted")).toBe(true);
  });
});



describe("GeocoderRegistry.forwardSelfHosted (self-hosted tier isolation)", () => {
  test("consults ONLY the self-hosted adapter — local + third-party are never invoked, no local shadow", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "lazy-tile"); // a LOCAL mode — forward's gate is INACTIVE
    const localSpy = vi.fn(async () => [candidate("bundled", "local", "local hit")]);
    const selfSpy = vi.fn(async () => [candidate("self-hosted", "self-hosted", "addr")]);
    const thirdSpy = vi.fn(async () => [candidate("third-party-mapbox", "third-party")]);
    reg.register(makeAdapter({ id: "bundled", tier: "local", forward: localSpy }));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: selfSpy }));
    reg.register(makeAdapter({ id: "third-party-mapbox", tier: "third-party", forward: thirdSpy }));

    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    expect(out.map((c) => c.label)).toEqual(["addr"]); // self-hosted only — local did NOT shadow
    expect(localSpy).not.toHaveBeenCalled();
    expect(thirdSpy).not.toHaveBeenCalled();
    expect(selfSpy).toHaveBeenCalledTimes(1);
  });

  test("returns [] (no throw) when no self-hosted adapter is registered", async () => {
    const reg = new GeocoderRegistry();
    reg.register(makeAdapter({ id: "bundled", tier: "local" }));
    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    expect(out).toEqual([]);
  });

  test("provider-failed emitted + [] on a non-abort throw", async () => {
    const reg = new GeocoderRegistry();
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: async () => { throw new Error("ECONNREFUSED"); } }));
    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    expect(out).toEqual([]);
    expect(events.some((e) => e.kind === "provider-failed" && e.provider === "self-hosted")).toBe(true);
  });

  test("AbortError re-throws (propagate-on-abort), not swallowed to []", async () => {
    const reg = new GeocoderRegistry();
    reg.register(makeAdapter({
      id: "self-hosted", tier: "self-hosted",
      forward: (_q, signal) => new Promise<GeocoderCandidate[]>((_, rej) => {
        if (signal.aborted) { rej(new DOMException("aborted", "AbortError")); return; }
        signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }),
    }));
    const ctrl = new AbortController();
    const p = reg.forwardSelfHosted("q", null, ctrl.signal);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    // Pin the ABORT contract specifically — a bare .rejects.toThrow() would pass on
    // any throw (e.g. a TypeError from a half-built mock) and only catch the
    // spec-warned abort-swallowing by luck (Should-fix). Assert the name is AbortError.
    await expect(p).rejects.toThrow(/abort/i);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  test("isAvailable()===false skips the adapter → []", async () => {
    const reg = new GeocoderRegistry();
    const selfSpy = vi.fn(async () => [candidate("self-hosted", "self-hosted")]);
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: selfSpy, available: false }));
    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    expect(out).toEqual([]);
    expect(selfSpy).not.toHaveBeenCalled();
  });

  test("does NOT consult forwardToken — a concurrent forward bumping the token does not blank forwardSelfHosted", async () => {
    const reg = new GeocoderRegistry();
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: async () => [candidate("self-hosted", "self-hosted", "addr")] }));
    // Start a concurrent forward (bumps forwardToken) without awaiting it.
    void reg.forward("other", null, new AbortController().signal);
    void reg.forward("other2", null, new AbortController().signal);
    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    // If forwardSelfHosted consulted forwardToken it would have returned [] after the concurrent
    // bumps. The documented exemption means it does not.
    expect(out.map((c) => c.label)).toEqual(["addr"]);
  });

  test("provider-recovered emitted UNCONDITIONALLY (exactly once) on a successful self-hosted forward", async () => {
    const reg = new GeocoderRegistry();
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: async () => [candidate("self-hosted", "self-hosted")] }));
    await reg.forwardSelfHosted("q", null, new AbortController().signal);
    const recovered = events.filter((e) => e.kind === "provider-recovered" && e.provider === "self-hosted");
    expect(recovered).toHaveLength(1); // exactly once per non-throwing forward
  });

  test("provider-recovered ALSO emitted (exactly once) on a successful-but-EMPTY self-hosted forward — no lower tier reached", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "lazy-tile"); // a LOCAL mode; forwardSelfHosted is mode-independent
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    // A local adapter ALSO registered: if forwardSelfHosted leaked into a tier-walk it
    // would consult the local tier after the empty self-hosted result. It must not.
    const localSpy = vi.fn(async () => [candidate("bundled", "local", "local hit")]);
    reg.register(makeAdapter({ id: "bundled", tier: "local", forward: localSpy }));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: async () => [] /* empty, no throw */ }));
    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    expect(out).toEqual([]); // empty result returned, not shadowed by the local tier
    expect(localSpy).not.toHaveBeenCalled();
    const recovered = events.filter((e) => e.kind === "provider-recovered" && e.provider === "self-hosted");
    expect(recovered).toHaveLength(1); // empty-but-non-throwing still signals recovery, once
  });

  test("provider-recovered emitted on a successful self-hosted REVERSE", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "server-side"); // reverse reaches self-hosted only under server-side gate
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", reverse: async () => candidate("self-hosted", "self-hosted", "addr") }));
    await reg.reverse({ lat: 0, lon: 0 }, new AbortController().signal);
    const recovered = events.filter((e) => e.kind === "provider-recovered" && e.provider === "self-hosted");
    expect(recovered).toHaveLength(1);
  });

  test("provider-recovered also emitted (exactly once) on a successful self-hosted forward via the tier-walking forward under server-side", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "server-side");
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: async () => [candidate("self-hosted", "self-hosted")] }));
    await reg.forward("q", null, new AbortController().signal);
    const recovered = events.filter((e) => e.kind === "provider-recovered" && e.provider === "self-hosted");
    // EXACTLY once (not ≥ once): the self-hosted tier is the sole consulted tier under
    // server-side, so the single shared emit site cannot fire twice (see the pinned
    // semantics above — structurally no double-emit).
    expect(recovered).toHaveLength(1);
  });

  test("forwardSelfHosted still emits recovery after a concurrent forward bumped the token (token-guard-free)", async () => {
    const reg = new GeocoderRegistry();
    const events: GeocoderStatusEvent[] = [];
    reg.status.subscribe((e) => events.push(e));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", forward: async () => [candidate("self-hosted", "self-hosted", "addr")] }));
    // Bump forwardToken via two concurrent (unawaited) forwards, then call the seam.
    void reg.forward("other", null, new AbortController().signal);
    void reg.forward("other2", null, new AbortController().signal);
    const out = await reg.forwardSelfHosted("q", null, new AbortController().signal);
    expect(out.map((c) => c.label)).toEqual(["addr"]);
    // The post-token-guard reasoning does NOT apply to forwardSelfHosted (it never
    // reads forwardToken), so recovery fires regardless of the concurrent bump.
    expect(events.some((e) => e.kind === "provider-recovered" && e.provider === "self-hosted")).toBe(true);
  });
});

describe("reverse tier-gate delta under a LOCAL mode", () => {
  test("local mode → reverse consults the local adapter FIRST; self-hosted only on local null", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "lazy-tile"); // local mode — gate INACTIVE
    const localHit = candidate("bundled", "local", "tapped place");
    const selfHit = candidate("self-hosted", "self-hosted", "server reverse");
    const localSpy = vi.fn(async () => localHit);
    const selfSpy = vi.fn(async () => selfHit);
    reg.register(makeAdapter({ id: "bundled", tier: "local", reverse: localSpy }));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", reverse: selfSpy }));
    const out = await reg.reverse({ lat: 0, lon: 0 }, new AbortController().signal);
    expect(out).toBe(localHit);            // local-first under a local mode
    expect(selfSpy).not.toHaveBeenCalled(); // self-hosted not reached when local answers
  });

  test("local mode + local returns null → falls through to self-hosted reverse", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "lazy-tile");
    const selfHit = candidate("self-hosted", "self-hosted", "server reverse");
    reg.register(makeAdapter({ id: "bundled", tier: "local", reverse: async () => null }));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", reverse: async () => selfHit }));
    const out = await reg.reverse({ lat: 0, lon: 0 }, new AbortController().signal);
    expect(out).toBe(selfHit);
  });

  test("explicit server-side → the local tier is STILL gated out on reverse (unchanged)", async () => {
    const reg = new GeocoderRegistry();
    reg.setActiveModeAccessor(() => "server-side");
    const selfHit = candidate("self-hosted", "self-hosted", "server reverse");
    const localSpy = vi.fn(async () => candidate("bundled", "local", "local"));
    reg.register(makeAdapter({ id: "bundled", tier: "local", reverse: localSpy }));
    reg.register(makeAdapter({ id: "self-hosted", tier: "self-hosted", reverse: async () => selfHit }));
    const out = await reg.reverse({ lat: 0, lon: 0 }, new AbortController().signal);
    expect(out).toBe(selfHit);
    expect(localSpy).not.toHaveBeenCalled();
  });
});
