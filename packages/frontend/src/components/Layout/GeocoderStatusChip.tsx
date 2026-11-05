import { useState, useEffect } from "react";
import { useTranslation } from "../../i18n/index.ts";
import { geocoderRegistry } from "../../services/geocoder/instance.ts";
import { onPoiLoadStatusChange, getPoiLoadErrors, poiCityIds } from "../../services/poiLoader.ts";
import type { PoiLoadError } from "../../services/poiLoader.ts";
import { useCityStore } from "../../stores/cityStore.ts";

interface PoiErrorState {
  error: PoiLoadError;
  partial: boolean;
}

export function GeocoderStatusChip() {
  const { t } = useTranslation();
  const [selfHostedFailed, setSelfHostedFailed] = useState(false);
  const [poiError, setPoiError] = useState<PoiErrorState | null>(null);
  const activeCityId = useCityStore((s) => s.activeCity.id);

  useEffect(() => {
    // Single subscription (empty dep array): a second subscribe would double- subscribe and leak a
    // listener. It handles BOTH set (provider- failed) and clear (provider-recovered) for the
    // self-hosted provider.
    const unsubscribe = geocoderRegistry.status.subscribe((event) => {
      if (event.provider !== "self-hosted") return;
      if (event.kind === "provider-failed") {
        setSelfHostedFailed(true);
      } else if (event.kind === "provider-recovered") {
        setSelfHostedFailed(false);
      }
      // provider-degraded is intentionally ignored here.
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const evaluate = (errors: ReadonlyMap<string, PoiLoadError>) => {
      const expected = poiCityIds(activeCityId);
      const relevantErrors = [...errors.values()].filter(
        (e) => e.tier === "strict" && expected.includes(e.cityId) && !e.hasCachedFallback,
      );
      if (relevantErrors.length === 0) {
        setPoiError(null);
        return;
      }
      const allFailed = expected.every((id) => relevantErrors.some((e) => e.cityId === id));
      const representative =
        relevantErrors.find((e) => e.kind === "quota") ?? relevantErrors[0]!;
      setPoiError({ error: representative, partial: !allFailed });
    };

    evaluate(getPoiLoadErrors());
    const unsubscribe = onPoiLoadStatusChange(evaluate);
    return unsubscribe;
  }, [activeCityId]);

  if (!selfHostedFailed && !poiError) return null;

  return (
    <>
      {selfHostedFailed && (
        <div
          className="bg-warning/10 text-warning text-xs text-center py-1.5 px-4"
          role="alert"
        >
          {t(
            "geocoder.fallback.selfHostedUnreachable",
            "Self-hosted geocoder unreachable \u2014 using on-device search only.",
          )}
        </div>
      )}
      {poiError && (
        <div
          className="bg-warning/10 text-warning text-xs text-center py-1.5 px-4"
          role="alert"
        >
          {poiError.error.kind === "quota"
            ? poiError.partial
              ? t(
                  "poi.error.quotaPartial",
                  "Storage full \u2014 some POI data may be incomplete.",
                )
              : t(
                  "poi.error.quota",
                  "Storage full \u2014 POI search unavailable.",
                )
            : poiError.partial
              ? t(
                  "poi.error.partialLoadFailed",
                  "Some POI data unavailable \u2014 search results may be incomplete.",
                )
              : t(
                  "poi.error.loadFailed",
                  "POI data unavailable \u2014 using stop search only.",
                )}
        </div>
      )}
    </>
  );
}
