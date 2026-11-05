// Default ON. The schedule-tile read path is the default departures source; the legacy
// /api/<city>/departures route is retained as the cascade fallback + rollback target.
// Off-switch matches the repo's other default-on env flags (e.g. VITE_PT_ADDR_AUG):
// the string "false" OR "0" disables; anything else (incl. unset) is ON.
const ENV_RAW = import.meta.env.VITE_PT_SCHEDULE_TILE_ENABLED as string | undefined;
const ENV_DEFAULT: boolean = ENV_RAW !== "false" && ENV_RAW !== "0";

function readUrlOverride(): boolean | null {
  if (typeof window === "undefined") return null; // SSR guard
  const url = new URL(window.location.href);
  const param = url.searchParams.get("ptn_schedule_tile");
  if (param === "true") return true;
  if (param === "false") return false;
  return null;
}

/** Default ON. Opt out globally with `VITE_PT_SCHEDULE_TILE_ENABLED=false` (or `=0`; build-time,
 *  redeploy) or per-user with `?ptn_schedule_tile=false`. SSR-safe: when window is undefined,
 *  `readUrlOverride` returns null without touching window, so the env default governs. */
export function isScheduleTileEnabled(): boolean {
  return readUrlOverride() ?? ENV_DEFAULT;
}
