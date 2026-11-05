import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { BaseEndpoint } from "@pt/shared";
import { db, type SavedLocationRecord } from "../../db/index.ts";
import {
  decrypt,
  type EncryptedRecord,
} from "../../services/cryptoBox.ts";
import { getOrCreateInstallKey } from "../../services/installKey.ts";
import { normalizeQuery, nameMatchScore } from "../../services/geocoder/BundledGeocoderAdapter.ts";
import { useTranslation } from "../../i18n/index.ts";

export interface ResolvedSave {
  id: string;
  alias: string;
  origin: BaseEndpoint;
  destination?: BaseEndpoint;
  savedAt: number;
}

export interface PinnedSavesSectionProps {
  onSelect: (save: ResolvedSave) => void;
  query?: string;
  compact?: boolean;
  /** Test hook: bypass live Dexie subscription. */
  rowsOverride?: SavedLocationRecord[] | null;
}

export function PinnedSavesSection({
  onSelect,
  query = "",
  compact = false,
  rowsOverride,
}: PinnedSavesSectionProps) {
  const { t } = useTranslation();
  const liveRows = useLiveQuery(
    () => db.savedLocations.toArray(),
    [],
  );
  const rows = rowsOverride ?? liveRows;
  const [resolved, setResolved] = useState<ResolvedSave[] | null>(null);

  useEffect(() => {
    if (!rows) return;
    let cancelled = false;
    (async () => {
      const out = await resolveSaves(rows);
      if (!cancelled) setResolved(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const [expandedQuery, setExpandedQuery] = useState<string | null>(null);
  const normalizedQuery = normalizeQuery(query);
  const matches = useMemo(() => filterSavedPlaces(resolved ?? [], query), [resolved, query]);
  const expanded = expandedQuery === normalizedQuery;
  const previewLimit = normalizedQuery ? 8 : 3;
  const visible = expanded ? matches : matches.slice(0, previewLimit);
  if (matches.length === 0) return null;

  return (
    <div
      role="list"
      aria-label={t("search.saved_places_trips", "Saved places and trips")}
      className="bg-surface-raised border-b border-divider"
    >
      <div className="px-4 pt-2 pb-1 text-xs font-semibold text-fg-muted uppercase tracking-wider">
        {t("search.saved_places_trips", "Saved places and trips")}
      </div>
      {visible.map((save) => (
        <button
          key={save.id}
          role="listitem"
          onClick={() => onSelect(save)}
          className={`w-full min-h-11 text-left px-4 ${compact ? "py-2" : "py-3"} border-b border-divider
            hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none
            focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent flex items-center gap-3`}
        >
          <span className="text-fg-muted text-lg" aria-hidden="true">
            {save.destination ? "\u{1F517}" : "\u{2B50}"}
          </span>
          <span className="text-sm text-fg flex-1 min-w-0">
            <span className="block truncate">{save.alias || labelFor(save)}</span>
            {save.alias && <span className="block text-xs text-fg-muted truncate">{labelFor(save)}</span>}
          </span>
        </button>
      ))}
      {matches.length > previewLimit && <button
        type="button"
        onClick={() => setExpandedQuery(expanded ? null : normalizedQuery)}
        aria-expanded={expanded}
        className="w-full min-h-11 px-4 py-2 text-left text-sm text-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {expanded ? t("search.saved_show_less", "Show fewer saved items") : t("search.saved_show_all", "Show all saved items ({n})").replace("{n}", String(matches.length))}
      </button>}
    </div>
  );
}

/** Same normalization and match tiers as place search; all work stays local. */
export function filterSavedPlaces(saves: ResolvedSave[], query: string): ResolvedSave[] {
  const normalized = normalizeQuery(query);
  const score = (save: ResolvedSave) => Math.max(
    nameMatchScore(normalized, save.alias),
    nameMatchScore(normalized, endpointLabel(save.origin)),
    save.destination ? nameMatchScore(normalized, endpointLabel(save.destination)) : 0,
    nameMatchScore(normalized, labelFor(save)),
  );
  return saves.map(save => ({ save, score: normalized ? score(save) : 1 }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.save.savedAt - a.save.savedAt)
    .map(item => item.save);
}

function labelFor(save: ResolvedSave): string {
  if (save.destination) {
    return `${endpointLabel(save.origin)} \u2192 ${endpointLabel(save.destination)}`;
  }
  return endpointLabel(save.origin);
}

function endpointLabel(ep: BaseEndpoint): string {
  if (ep.kind === "stop") return ep.name;
  if (ep.kind === "geocoded") return ep.label;
  if (ep.kind === "stopGroup") return ep.label;
  return `${ep.lat.toFixed(4)}, ${ep.lon.toFixed(4)}`;
}

async function resolveSaves(
  rows: SavedLocationRecord[],
): Promise<ResolvedSave[]> {
  const sorted = [...rows].sort((a, b) => b.savedAt - a.savedAt);
  const needsKey = sorted.some((r) => r.encrypted || r.aliasCipher);
  const key = needsKey
    ? await getOrCreateInstallKey().catch(() => null)
    : null;

  const out: ResolvedSave[] = [];
  for (const row of sorted) {
    let origin: BaseEndpoint;
    let destination: BaseEndpoint | undefined;
    let alias = row.alias;
    if (row.encrypted) {
      if (!key) continue;
      try {
        origin = (await decrypt(
          row.endpoint as EncryptedRecord,
          key,
        )) as BaseEndpoint;
        if (row.destinationEndpoint) {
          destination = (await decrypt(
            row.destinationEndpoint as EncryptedRecord,
            key,
          )) as BaseEndpoint;
        }
      } catch {
        continue;
      }
    } else {
      origin = row.endpoint as BaseEndpoint;
      destination = row.destinationEndpoint as BaseEndpoint | undefined;
    }
    if (row.aliasCipher && key) {
      try {
        alias = (await decrypt(row.aliasCipher, key)) as string;
      } catch {
        alias = "";
      }
    }
    out.push({
      id: row.id,
      alias,
      origin,
      destination,
      savedAt: row.savedAt,
    });
  }
  return out;
}
