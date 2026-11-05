import { it, expect, vi, beforeEach } from "vitest";
import { prewarmPhase1, prewarmPhase2, __resetPrewarmForTests, MIN_DOTS_TO_PREWARM } from "./scheduleTilePrewarm.ts";

const handle = (dots: number, center = { lat: 54.6872, lng: 25.2797 }) => ({
  getLayer: () => ({}), queryRenderedFeatures: () => Array.from({ length: dots }, () => ({})),
  getCenter: () => center, getZoom: () => 14,
});
beforeEach(() => { __resetPrewarmForTests(); vi.resetAllMocks(); vi.restoreAllMocks(); });

it("Phase 1 runs each warmer at most once per session", async () => {
  const a = vi.fn(), b = vi.fn(), c = vi.fn();
  const deps = { warmupBrotli: a, warmManifest: b, importReadPath: c };
  await prewarmPhase1(deps); await prewarmPhase1(deps);
  expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce(); expect(c).toHaveBeenCalledOnce();
});

it("Phase 2 skips when only clusters (dots below threshold)", async () => {
  const fetchTile = vi.fn().mockResolvedValue(0);
  await prewarmPhase2(handle(MIN_DOTS_TO_PREWARM - 1), { fetchTile, resolveCoords: () => "271_1014", bundleHash: () => "h" });
  expect(fetchTile).not.toHaveBeenCalled();
});

it("Phase 2 fetches the center tile once; idempotent on the same cell", async () => {
  const fetchTile = vi.fn().mockResolvedValue(500_000);
  const deps = { fetchTile, resolveCoords: () => "271_1014", bundleHash: () => "h" };
  await prewarmPhase2(handle(MIN_DOTS_TO_PREWARM), deps);
  await prewarmPhase2(handle(MIN_DOTS_TO_PREWARM), deps);
  expect(fetchTile).toHaveBeenCalledOnce();
});

it("Phase 2 no-ops when DOT_LAYER is absent", async () => {
  const fetchTile = vi.fn().mockResolvedValue(0);
  await prewarmPhase2({ ...handle(99), getLayer: () => undefined }, { fetchTile, resolveCoords: () => "1_1", bundleHash: () => "h" });
  expect(fetchTile).not.toHaveBeenCalled();
});

it("Phase 2 stops once the per-session byte budget is exhausted", async () => {
  const fetchTile = vi.fn().mockResolvedValue(5_000_000); // each ~5MB; budget 8MB
  await prewarmPhase2(handle(99), { fetchTile, resolveCoords: () => "1_1", bundleHash: () => "h" });
  await prewarmPhase2(handle(99), { fetchTile, resolveCoords: () => "2_2", bundleHash: () => "h" });
  expect(fetchTile).toHaveBeenCalledOnce(); // 2nd cell would exceed 8MB
});
