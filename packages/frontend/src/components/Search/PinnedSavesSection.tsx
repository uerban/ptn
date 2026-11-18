import { useMemo, useRef, useState } from "react";
import type { BaseEndpoint } from "@pt/shared";
import { deleteSave, renameSave, saveBelongsToCity, type ResolvedSave } from "../../services/saves.ts";
import { RecentRow } from "./RecentRow.tsx";
import { RecentNotice, type RecentNoticeState } from "./RecentNotice.tsx";
import { useResolvedSaves } from "../../hooks/useResolvedSaves.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { normalizeQuery, nameMatchScore } from "../../services/geocoder/BundledGeocoderAdapter.ts";
import { useTranslation } from "../../i18n/index.ts";

export type { ResolvedSave };

export interface PinnedSavesSectionProps {
  onSelect: (save: ResolvedSave) => void;
  query?: string;
  compact?: boolean;
  /** Test hook: bypass live Dexie subscription. */
  rowsOverride?: readonly unknown[] | null;
}

export function PinnedSavesSection(props: PinnedSavesSectionProps) {
  const cityId = useCityStore(s => s.activeCity.id);
  return <CityPinnedSavesSection key={cityId} {...props} cityId={cityId} />;
}

function CityPinnedSavesSection({
  onSelect,
  query = "",
  compact = false,
  rowsOverride,
  cityId,
}: PinnedSavesSectionProps & {cityId: string}) {
  const { t } = useTranslation();
  const all = useResolvedSaves(rowsOverride);
  // Saves belong to the city where they were made; ownership is sealed, so it
  // is filtered after decrypting.
  const resolved = useMemo(
    () => all?.filter((save) => saveBelongsToCity(save, cityId)) ?? null,
    [all, cityId],
  );

  const [expandedQuery, setExpandedQuery] = useState<string | null>(null);
  // Removed saves leave the list at once; the delete is final when Undo ends.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ id: string; notice: RecentNoticeState } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const normalizedQuery = normalizeQuery(query);
  const matches = useMemo(
    () => filterSavedPlaces(resolved ?? [], query).filter((save) => !hidden.has(save.id)),
    [resolved, query, hidden],
  );
  const expanded = expandedQuery === normalizedQuery;
  const previewLimit = normalizedQuery ? 8 : 3;
  const shown = expanded ? matches : matches.slice(0, previewLimit);
  // The Undo notice takes the removed save's place in the list.
  const allMatches = filterSavedPlaces(resolved ?? [], query);
  const visible = allMatches.filter((save) => shown.includes(save) || save.id === notice?.id);
  if (matches.length === 0 && !notice) return null;

  const remove = (save: ResolvedSave) => {
    setHidden((prev) => new Set(prev).add(save.id));
    setNotice({
      id: save.id,
      notice: {
        kind: "removed",
        label: save.alias || labelFor(save),
        commit: () => void deleteSave(save.id).catch(() => {}),
        undo: () => setHidden((prev) => {
          const next = new Set(prev);
          next.delete(save.id);
          return next;
        }),
      },
    });
  };
  const removedNotice = notice && (
    <RecentNotice
      key={`notice:${notice.id}`}
      notice={notice.notice}
      onDone={() => setNotice(null)}
      text={{
        saved: "",
        removed: t("search.saved_removed", "Removed {label} from saved"),
        undo: t("search.recent_undo", "Undo"),
      }}
    />
  );

  return (
    <div
      role="list"
      aria-label={t("search.saved_places_trips", "Saved places and trips")}
      className="bg-surface-raised border-b border-divider"
    >
      <div className="px-4 pt-2 pb-1 text-xs font-semibold text-fg-muted uppercase tracking-wider">
        {t("search.saved_places_trips", "Saved places and trips")}
      </div>
      {visible.map((save) => save.id === notice?.id && hidden.has(save.id) ? (
        <div role="listitem" key={save.id}>{removedNotice}</div>
      ) : save.id === renaming ? (
        <div role="listitem" key={save.id}>
          <RenameField
            save={save}
            label={t("search.saved_rename_label", "Name for {label}").replace("{label}", labelFor(save))}
            onDone={(alias) => {
              setRenaming(null);
              if (alias !== null && alias.trim() !== save.alias) void renameSave(save.id, alias).catch(() => {});
            }}
          />
        </div>
      ) : (
        <div role="listitem" key={save.id}>
        <RecentRow
          label={save.alias || labelFor(save)}
          onRename={() => setRenaming(save.id)}
          onRemove={() => remove(save)}
          text={{
            actions: t("search.recent_actions", "Actions for {label}"),
            rename: t("search.saved_rename", "Rename"),
            remove: t("search.saved_remove", "Remove from saved"),
          }}
        >
        <button
          type="button"
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
        </RecentRow>
        </div>
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

/**
 * Inline name field for a save. Enter or leaving the field keeps the name,
 * Escape cancels; an empty name shows the place or trip again.
 */
function RenameField({ save, label, onDone }: {
  save: ResolvedSave;
  label: string;
  onDone: (alias: string | null) => void;
}) {
  const [value, setValue] = useState(save.alias || labelFor(save));
  const done = useRef(false);
  const finish = (alias: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(alias);
  };
  return (
    <form
      className="flex items-center gap-3 px-4 py-2 border-b border-divider"
      onSubmit={(e) => {
        e.preventDefault();
        finish(value);
      }}
    >
      <span className="text-fg-muted text-lg" aria-hidden="true">
        {save.destination ? "\u{1F517}" : "\u{2B50}"}
      </span>
      <input
        autoFocus
        data-testid="saved-rename-input"
        aria-label={label}
        value={value}
        placeholder={labelFor(save)}
        maxLength={80}
        enterKeyHint="done"
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => finish(value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(null);
          }
        }}
        className="min-w-0 flex-1 min-h-11 rounded-md border border-divider bg-surface px-3 text-base text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </form>
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
