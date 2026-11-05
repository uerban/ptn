const VILNIUS_DEFAULT = "https://stops.lt/vilnius/vilnius/gtfs.zip";

/**
 * Resolve the configured GTFS static feed URLs.
 *
 * `rawEnv` is the raw `GTFS_STATIC_URL` (comma-separated, possibly empty/unset).
 * `ptbMode` is true when `PT_BUNDLE_PATH` is set (PTB / data-root boot).
 *
 * When `rawEnv` is empty we normally substitute the vilnius dev default. But in
 * PTB mode that default is dangerous: if the PTB load fails, the scheduler would
 * silently download and serve an unrelated city. So in PTB mode an empty
 * `GTFS_STATIC_URL` resolves to `[]`, which the scheduler treats as "no fallback
 * configured" and fails closed (see scheduler.ts). Explicit URLs are always
 * honoured (the 5 prod cities set a correct per-city URL).
 */
export function resolveGtfsStaticUrls(rawEnv: string | undefined, ptbMode: boolean): string[] {
  const raw = (rawEnv ?? "").trim();
  const source = raw || (ptbMode ? "" : VILNIUS_DEFAULT);
  return Array.from(new Set(source.split(",").map((u) => u.trim()).filter(Boolean)));
}
