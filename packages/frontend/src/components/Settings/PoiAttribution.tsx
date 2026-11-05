import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../db/index.ts";
import { useTranslation } from "../../i18n/index.ts";

export function PoiAttribution() {
  const { t } = useTranslation();

  const metas = useLiveQuery(() => db.poiSyncMeta.toArray(), []);

  const strictMetas = metas?.filter((m) => m.tier === "strict") ?? [];
  const totalEntries = strictMetas.reduce((sum, m) => sum + m.entryCount, 0);
  const latestGenerated = strictMetas
    .map((m) => m.bundleGeneratedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const latestSource = strictMetas
    .map((m) => m.sourcePbfTimestamp)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <div className="mt-3 space-y-1">
      <p className="text-xs text-fg-muted">
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {t("settings.osm_attribution", "Map data \u00a9 OpenStreetMap contributors, ODbL")}
        </a>
      </p>
      {totalEntries > 0 && (
        <p className="text-xs text-fg-muted">
          {t("settings.poi_entries", "{count} places indexed").replace("{count}", String(totalEntries))}
          {latestSource && (
            <> &middot; {t("settings.poi_source_date", "Source data: {date}").replace("{date}", formatDate(latestSource))}</>
          )}
          {latestGenerated && (
            <> &middot; {t("settings.poi_generated", "Generated: {date}").replace("{date}", formatDate(latestGenerated))}</>
          )}
        </p>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
