/** Graph adoption is deferred while guidance is active. Releasing the worker
 * between sessions preserves the single-graph budget, and the next load can
 * validate the newest release or recover its native-validated offline copy. */
import {useGuidanceStore} from "../stores/guidanceStore.ts";
import {walkGraphClient} from "./walkGraphClient.ts";
import {clearWalkRouteCache} from "./walkRouteCache.ts";

export const WALK_GRAPH_ADOPTION_MS = 5 * 60_000;

export function installWalkGraphAdoption(
  reset: () => void = () => {walkGraphClient.destroy(); clearWalkRouteCache();},
): () => void {
  walkGraphClient.setGuidanceActive(useGuidanceStore.getState().phase !== "idle");
  const maybeReset = () => {
    if (useGuidanceStore.getState().phase === "idle") reset();
  };
  const unsubscribe = useGuidanceStore.subscribe((state, previous) => {
    walkGraphClient.setGuidanceActive(state.phase !== "idle");
    if (state.phase === "idle" && previous.phase !== "idle") reset();
  });
  const visible = () => {
    if (document.visibilityState === "visible") maybeReset();
  };
  const timer = setInterval(maybeReset, WALK_GRAPH_ADOPTION_MS);
  document.addEventListener("visibilitychange", visible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
    unsubscribe();
    walkGraphClient.setGuidanceActive(false);
  };
}
