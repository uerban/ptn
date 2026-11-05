/**
 * Resolve the display-time tz state from the static config tz (CityConfig.tz),
 * the bundle's meta.cityTzIana (when the server provided it), and the device tz.
 *

 * * Rules: - configTz present + metaTz present + equal → verified, feedTz = configTz. -
 * configTz present + metaTz present + differ → DRIFT: feedTz = configTz (the static SoT mirror
 * still drives display) but `unverified` so the indicator warns and the caller logs. - configTz
 * present + metaTz absent → trust config; NOT unverified (the network-GTFS path simply can't
 * cross-check). - configTz absent → device-local; `unverified` (self-hosted / dev-override city
 * with no declared tz). `crossTz` is true whenever the effective feed tz differs from the
 * device tz.
 */
export interface TzState {
  feedTz: string | undefined;
  crossTz: boolean;
  unverified: boolean;
}

export function resolveTzState(
  configTz: string | undefined,
  metaTz: string | undefined,
  deviceTz: string,
): TzState {
  if (!configTz) {
    // No config tz → device-local display; the badge surfaces via `unverified`
    // alone (crossTz is moot here). [R-fold v4 NIT: was `deviceTz !== undefined`, a tautology.]
    return { feedTz: undefined, crossTz: false, unverified: true };
  }
  const drift = metaTz !== undefined && metaTz !== configTz;
  return {
    feedTz: configTz,
    crossTz: configTz !== deviceTz,
    unverified: drift,
  };
}

/** The device's current IANA tz (via Intl). */
export function deviceTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
