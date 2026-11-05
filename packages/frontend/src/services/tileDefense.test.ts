import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dispatchTileLoad,
  startDecoyTimer,
  _resetSessionNonceForTests,
  _setSessionNonceForTests,
  type VisibilityTarget,
} from "./tileDefense.ts";

function cityGrid(): string[] {
  const keys: string[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      keys.push(`gdansk/12km/${x}_${y}`);
    }
  }
  return keys;
}

// Deterministic RNG: cycles through a fixed sequence so decoy picks are stable.
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("dispatchTileLoad — strategy: none", () => {
  it("returns realTileKeys verbatim with no decoys", () => {
    const real = ["gdansk/12km/1_1", "gdansk/12km/2_1"];
    const plan = dispatchTileLoad(real, { m11TileDefense: "none" });
    expect(plan.tileKeys).toEqual(real);
    expect(plan.decoyKeys).toEqual([]);
    expect(plan.markPrefetched).toBe(false);
  });

  it("ignores cityTileKeys and prefetched context", () => {
    const plan = dispatchTileLoad(["gdansk/12km/0_0"], {
      m11TileDefense: "none",
    }, {
      cityTileKeys: cityGrid(),
      prefetched: false,
    });
    expect(plan.tileKeys).toEqual(["gdansk/12km/0_0"]);
    expect(plan.decoyKeys).toEqual([]);
  });
});

describe("dispatchTileLoad — strategy: prefetch", () => {
  it("returns full city tile set on first load (not yet prefetched)", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    const plan = dispatchTileLoad(real, { m11TileDefense: "prefetch" }, {
      cityTileKeys: city,
      prefetched: false,
    });
    for (const key of city) {
      expect(plan.tileKeys).toContain(key);
    }
    expect(plan.tileKeys).toContain("gdansk/12km/1_1");
    expect(plan.markPrefetched).toBe(true);
    expect(plan.decoyKeys).toEqual([]);
  });

  it("subsequent calls return only realTileKeys once prefetched", () => {
    const real = ["gdansk/12km/2_2"];
    const plan = dispatchTileLoad(real, { m11TileDefense: "prefetch" }, {
      cityTileKeys: cityGrid(),
      prefetched: true,
    });
    expect(plan.tileKeys).toEqual(real);
    expect(plan.markPrefetched).toBe(false);
    expect(plan.decoyKeys).toEqual([]);
  });

  it("when cityTileKeys missing, falls back to realTileKeys", () => {
    const real = ["gdansk/12km/0_0"];
    const plan = dispatchTileLoad(real, { m11TileDefense: "prefetch" });
    expect(plan.tileKeys).toEqual(real);
    expect(plan.markPrefetched).toBe(false);
  });

  it("post-prefetch viewport change with all tiles cached returns []", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1", "gdansk/12km/2_1"];
    const plan = dispatchTileLoad(real, { m11TileDefense: "prefetch" }, {
      cityTileKeys: city,
      prefetched: true,
      cachedKeys: new Set(city),
    });
    expect(plan.tileKeys).toEqual([]);
    expect(plan.decoyKeys).toEqual([]);
    expect(plan.markPrefetched).toBe(false);
  });

  it("post-prefetch viewport change skips cached tiles but requests uncached", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/0_0", "gdansk/12km/3_3"];
    const plan = dispatchTileLoad(real, { m11TileDefense: "prefetch" }, {
      cityTileKeys: city,
      prefetched: true,
      cachedKeys: new Set(["gdansk/12km/0_0"]),
    });
    expect(plan.tileKeys).toEqual(["gdansk/12km/3_3"]);
    expect(plan.markPrefetched).toBe(false);
  });

  it("first load skips the cached subset but still marks prefetched", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    const cached = new Set(["gdansk/12km/0_0", "gdansk/12km/0_1"]);
    const plan = dispatchTileLoad(real, { m11TileDefense: "prefetch" }, {
      cityTileKeys: city,
      prefetched: false,
      cachedKeys: cached,
    });
    for (const key of cached) {
      expect(plan.tileKeys).not.toContain(key);
    }
    expect(plan.tileKeys).toContain("gdansk/12km/1_1");
    expect(plan.markPrefetched).toBe(true);
  });
});

describe("dispatchTileLoad — strategy: prefetch-padding", () => {
  it("adds 2 random in-city decoys alongside real tiles", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    const plan = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(1) },
    );
    expect(plan.decoyKeys).toHaveLength(2);
    for (const decoy of plan.decoyKeys) {
      expect(city).toContain(decoy);
      expect(real).not.toContain(decoy);
    }
    for (const key of real) {
      expect(plan.tileKeys).toContain(key);
    }
    for (const decoy of plan.decoyKeys) {
      expect(plan.tileKeys).toContain(decoy);
    }
  });

  it("decoy picks are deterministic given a seeded RNG", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/0_0"];
    const first = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(42) },
    );
    const second = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(42) },
    );
    expect(second.decoyKeys).toEqual(first.decoyKeys);
  });

  it("triggers full-city prefetch on first load", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    const plan = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: false, rng: seededRng(7) },
    );
    for (const key of city) {
      expect(plan.tileKeys).toContain(key);
    }
    expect(plan.markPrefetched).toBe(true);
  });

  it("excludes realTileKeys from decoy candidates", () => {
    const city = cityGrid();
    const real = city.slice(0, city.length - 2);
    const plan = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(3) },
    );
    for (const decoy of plan.decoyKeys) {
      expect(real).not.toContain(decoy);
    }
  });

  it("picks 0 decoys when no remaining city tiles are available", () => {
    const city = ["gdansk/12km/0_0", "gdansk/12km/1_0"];
    const real = [...city];
    const plan = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(1) },
    );
    expect(plan.decoyKeys).toHaveLength(0);
  });

  it("when cityTileKeys missing, returns realTileKeys with no decoys", () => {
    const real = ["gdansk/12km/1_1"];
    const plan = dispatchTileLoad(real, {
      m11TileDefense: "prefetch-padding",
    });
    expect(plan.tileKeys).toEqual(real);
    expect(plan.decoyKeys).toEqual([]);
  });

  it("excludes already-cached tiles from decoy candidates", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    const cached = new Set(city.filter((k) => k !== "gdansk/12km/3_3" && k !== real[0]));
    const plan = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, cachedKeys: cached, rng: seededRng(9) },
    );
    for (const decoy of plan.decoyKeys) {
      expect(cached.has(decoy)).toBe(false);
    }
    expect(plan.decoyKeys).toEqual(["gdansk/12km/3_3"]);
  });
});

describe("dispatchTileLoad — session-nonce default RNG", () => {
  beforeEach(() => {
    _resetSessionNonceForTests();
  });

  it("produces stable decoys for identical inputs within a single session", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    const first = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true },
    );
    const second = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true },
    );
    expect(first.decoyKeys).toHaveLength(2);
    expect(second.decoyKeys).toEqual(first.decoyKeys);
  });

  it("produces different decoys after the session nonce is reset", () => {
    // A reset session nonce changes the decoy RNG seed, so the same viewport
    // draws a different decoy pair. The old version regenerated a *random*
    // nonce on reset and retried up to 5× to dodge a same-pair collision
    // (~0.46%/draw) — astronomically unlikely to fail, but still run-to-run
    // random. Pinning two distinct, verified nonces makes the outcome stable
    // forever while still exercising the real `defaultRng` seeding path.
    const city = cityGrid();
    const real = ["gdansk/12km/1_1"];
    _setSessionNonceForTests("ptn-tile-defense-reset-nonce-a");
    const first = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true },
    );
    _setSessionNonceForTests("ptn-tile-defense-reset-nonce-b");
    const next = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true },
    );
    expect(first.decoyKeys).toHaveLength(2);
    expect(next.decoyKeys).toHaveLength(2);
    const matched =
      next.decoyKeys.length === first.decoyKeys.length &&
      next.decoyKeys.every((k, i) => k === first.decoyKeys[i]);
    expect(matched).toBe(false);
  });

  it("varies decoys when realTileKeys differ within one session", () => {
    // Pin a fixed session nonce so the default decoy RNG is reproducible
    // run-to-run. The old version let `getSessionNonce()` mint a fresh random
    // nonce each run (crypto.randomUUID / Math.random), so a single-pair
    // "different reals ⇒ different decoys" assertion landed on a colliding seed
    // ~0.4% of runs over this small 4×4 grid → the CI flake.
    //
    // We still exercise the real `defaultRng` seeding path (nonce + realKeys
    // → FNV-1a → mulberry32); only the nonce *source* is fixed. The property
    // under test ("distinct realTileKeys ⇒ distinct decoy sets") is asserted
    // over SEVERAL distinct single-tile viewports, and we require AT LEAST 4 of
    // the 5 decoy sets to be distinct rather than all 5. On this small 4×4 grid
    // a coincidental collision between two of the five sets is possible for some
    // nonces; tolerating one keeps the assertion nonce-insensitive (≥4-of-5
    // holds for ~every nonce) while still proving the property. The nonce is
    // pinned only for determinism/reproducibility — not because it must be a
    // "verified all-distinct" pick, so a future viewport edit needs no re-verify.
    _setSessionNonceForTests("ptn-tile-defense-test-nonce-v0");
    const city = cityGrid();
    const viewports = [
      "gdansk/12km/0_0",
      "gdansk/12km/3_3",
      "gdansk/12km/1_2",
      "gdansk/12km/2_1",
      "gdansk/12km/0_3",
    ];
    const decoySets = viewports.map((tile) => {
      const plan = dispatchTileLoad(
        [tile],
        { m11TileDefense: "prefetch-padding" },
        { cityTileKeys: city, prefetched: true },
      );
      expect(plan.decoyKeys).toHaveLength(2);
      return plan.decoyKeys.join("|");
    });
    // Distinct viewports produce distinct decoy sets — tolerating at most one
    // coincidental collision (≥4 of 5 distinct) so the test stays nonce-insensitive.
    expect(new Set(decoySets).size).toBeGreaterThanOrEqual(4);
  });
});

describe("dispatchTileLoad — strategy: prefetch-padding-decoy", () => {
  it("per-call composition matches prefetch-padding", () => {
    const city = cityGrid();
    const real = ["gdansk/12km/2_2"];
    const a = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding-decoy" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(11) },
    );
    const b = dispatchTileLoad(
      real,
      { m11TileDefense: "prefetch-padding" },
      { cityTileKeys: city, prefetched: true, rng: seededRng(11) },
    );
    expect(a.tileKeys).toEqual(b.tileKeys);
    expect(a.decoyKeys).toEqual(b.decoyKeys);
  });

  it("sets decoyTimerActive=true (other strategies set false)", () => {
    const ctx = {
      cityTileKeys: cityGrid(),
      prefetched: true,
      rng: seededRng(1),
    };
    const decoy = dispatchTileLoad(
      ["gdansk/12km/0_0"],
      { m11TileDefense: "prefetch-padding-decoy" },
      ctx,
    );
    const padding = dispatchTileLoad(
      ["gdansk/12km/0_0"],
      { m11TileDefense: "prefetch-padding" },
      ctx,
    );
    const none = dispatchTileLoad(
      ["gdansk/12km/0_0"],
      { m11TileDefense: "none" },
    );
    expect(decoy.decoyTimerActive).toBe(true);
    expect(padding.decoyTimerActive).toBe(false);
    expect(none.decoyTimerActive).toBe(false);
  });
});

interface FakeVisibilityDoc extends VisibilityTarget {
  _setVisibility(state: DocumentVisibilityState): void;
  listenerCount(type: string): number;
}

function makeFakeDoc(): FakeVisibilityDoc {
  const listeners = new Map<string, Set<() => void>>();
  let visibility: DocumentVisibilityState = "visible";
  return {
    get visibilityState() {
      return visibility;
    },
    addEventListener(type, cb) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    _setVisibility(state) {
      visibility = state;
      const set = listeners.get("visibilitychange");
      if (set) for (const cb of [...set]) cb();
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe("startDecoyTimer — prefetch-padding-decoy runtime", () => {
  let doc: FakeVisibilityDoc;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = makeFakeDoc();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a decoy tile fetch at least once within 2-5 min of start", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      visibilityTarget: doc,
      rng: seededRng(1),
    });
    // Below the 2-min floor — nothing should fire yet.
    vi.advanceTimersByTime(90_000);
    expect(onFire).not.toHaveBeenCalled();
    // Past the 5-min ceiling — at least one fire should have landed
    // (a second may land too if the reschedule delay fits inside the window).
    vi.advanceTimersByTime(5 * 60_000);
    expect(onFire.mock.calls.length).toBeGreaterThanOrEqual(1);
    ctrl.stop();
  });

  it("keeps firing on subsequent intervals", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      visibilityTarget: doc,
      rng: seededRng(7),
    });
    vi.advanceTimersByTime(15 * 60_000);
    // Window is [2,5]min, so in 15min we should see 3-7 fires; assert at least 3.
    expect(onFire.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Every fire passes a real city tile key.
    for (const call of onFire.mock.calls) {
      expect(cityGrid()).toContain(call[0]);
    }
    ctrl.stop();
  });

  it("delay stays in [intervalMinMs, intervalMaxMs]", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      visibilityTarget: doc,
      rng: seededRng(3),
    });
    // Below floor → none.
    vi.advanceTimersByTime(999);
    expect(onFire).not.toHaveBeenCalled();
    // Above ceiling → fired.
    vi.advanceTimersByTime(1500);
    expect(onFire).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("stops firing while document.visibilityState is 'hidden'", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      visibilityTarget: doc,
      rng: seededRng(9),
    });
    // Fire once so we know the loop is alive.
    vi.advanceTimersByTime(5 * 60_000);
    const firedBefore = onFire.mock.calls.length;
    expect(firedBefore).toBeGreaterThan(0);

    doc._setVisibility("hidden");
    vi.advanceTimersByTime(30 * 60_000);
    expect(onFire.mock.calls.length).toBe(firedBefore);
    ctrl.stop();
  });

  it("resumes firing once visibility returns", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      visibilityTarget: doc,
      rng: seededRng(11),
    });
    doc._setVisibility("hidden");
    vi.advanceTimersByTime(10 * 60_000);
    expect(onFire).not.toHaveBeenCalled();

    doc._setVisibility("visible");
    vi.advanceTimersByTime(5 * 60_000);
    expect(onFire.mock.calls.length).toBeGreaterThan(0);
    ctrl.stop();
  });

  it("does not start firing when initialised with hidden visibility", () => {
    doc._setVisibility("hidden");
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      visibilityTarget: doc,
      rng: seededRng(13),
    });
    vi.advanceTimersByTime(30 * 60_000);
    expect(onFire).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("stop() clears any scheduled fire and removes the visibility listener", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire,
      visibilityTarget: doc,
      rng: seededRng(5),
    });
    expect(doc.listenerCount("visibilitychange")).toBe(1);
    ctrl.stop();
    vi.advanceTimersByTime(30 * 60_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(doc.listenerCount("visibilitychange")).toBe(0);
  });

  it("is a no-op when cityTileKeys is empty", () => {
    const onFire = vi.fn();
    const ctrl = startDecoyTimer({
      cityTileKeys: [],
      onFire,
      visibilityTarget: doc,
      rng: seededRng(1),
    });
    vi.advanceTimersByTime(30 * 60_000);
    expect(onFire).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("stop() is idempotent", () => {
    const ctrl = startDecoyTimer({
      cityTileKeys: cityGrid(),
      onFire: vi.fn(),
      visibilityTarget: doc,
      rng: seededRng(1),
    });
    ctrl.stop();
    expect(() => ctrl.stop()).not.toThrow();
    expect(doc.listenerCount("visibilitychange")).toBe(0);
  });
});
