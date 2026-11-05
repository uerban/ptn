import { useCityStore } from "../../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../../stores/gtfsDataStore.ts";
import { useTranslation } from "../../../i18n/index.ts";
import { resolveTzState, deviceTz } from "../../../services/feedTz.ts";

/**
 * Small badge shown next to result times when they are rendered in a tz other
 * than the device's (cross-tz user), or when the config tz could not be verified
 * against the bundle's agency tz (drift). Renders nothing for a local user with a
 * verified tz. The bundle tz comes from the store (set on fresh AND cached
 * hydration, Step 4), so drift surfaces on the warm-start path too.
 */
export function TzIndicator({ bundleTz }: { bundleTz?: string }) {
  const { t } = useTranslation();
  const configTz = useCityStore((s) => s.activeCity.tz);
  const storeBundleTz = useGtfsDataStore((s) => s.bundleCityTzIana ?? undefined);
  const state = resolveTzState(configTz, bundleTz ?? storeBundleTz, deviceTz());
  if (!state.crossTz && !state.unverified) return null;
  // [R-fold #12] Localized labels + a DST-STABLE, generic tz name (not the raw IANA string; bullet
  // 4). Uses `timeZoneName: "shortGeneric"` → "Lithuania Time" / "Poland Time" / "France Time" /
  // "Georgia Time" ("ET" for US zones). Deliberately NOT `"short"`: that yields a SEASONAL GMT
  // offset ("GMT+3"/"GMT+2") computed at RENDER time, which can disagree with the offset of the
  // result times on screen when a query/pagination crosses a DST boundary. The generic name is
  // instant-independent, so it is correct regardless of which instant is shown. The `?? tz` IANA
  // fallback is defensive (timeZoneName is in practice always present).
  const tzName = (tz: string): string => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortGeneric",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  };
  // [R-fold v4 SHOULD-FIX #7] THREE display states (resolveTzState):
  //  - no config tz (feedTz undefined): times render device-local → "device time".
  //  - drift (feedTz set, mismatches bundle): times STILL render in the config feed
  //    tz (a real zone) → "<TZ> · city time (unverified)", NOT "device time".
  //  - verified cross-tz: "<TZ> · city time".
  let label: string;
  let hint: string;
  if (!state.feedTz) {
    label = t("tz.device_time", "device time");
    hint = t(
      "tz.device_time_hint",
      "No city timezone configured; times are shown in your device's timezone.",
    );
  } else if (state.unverified) {
    label = t("tz.unverified", "{tz} · city time (unverified)").replace(
      "{tz}",
      tzName(state.feedTz),
    );
    hint = t(
      "tz.unverified_hint",
      "Times are in the city's timezone, but it could not be confirmed against the feed.",
    );
  } else {
    label = t("tz.city_time", "{tz} · city time").replace("{tz}", tzName(state.feedTz));
    hint = t("tz.city_time_hint", "Times are in the city's local time.");
  }
  return (
    <span
      className="ml-1 align-middle text-[10px] font-medium text-fg-muted"
      title={hint}
      data-testid="tz-indicator"
    >
      {label}
    </span>
  );
}
