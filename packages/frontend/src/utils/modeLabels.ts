import type { TransportMode } from "@pt/shared";
import type { IconName } from "../components/Icon.tsx";

/**
 * English name and Latin badge glyph per mode. Both are fallbacks: the name
 * is served from `settings.mode_*` and the glyph from `mode.glyph_*` for any
 * locale that carries them.
 */
export const MODE_CONFIG: Record<
  TransportMode,
  { label: string; icon: string }
> = {
  BUS: { label: "Bus", icon: "B" },
  TRAM: { label: "Tram", icon: "T" },
  TROLLEYBUS: { label: "Trolleybus", icon: "Tb" },
  METRO: { label: "Metro", icon: "M" },
  RAIL: { label: "Rail", icon: "R" },
  FERRY: { label: "Ferry", icon: "F" },
  CABLE_TRAM: { label: "Cable Tram", icon: "Ct" },
  AERIAL: { label: "Aerial", icon: "Ae" },
  OTHER: { label: "Other", icon: "O" },
  FUNICULAR: { label: "Funicular", icon: "Fu" },
  WALK: { label: "Walk", icon: "W" },
  BIKE: { label: "Bike", icon: "Bk" },
  BIKE_SHARE: { label: "Bike Share", icon: "Bs" },
  SCOOTER: { label: "Scooter", icon: "S" },
  CAR: { label: "Car", icon: "Ca" },
};

type Translate = (key: string, fallback?: string) => string;

/**
 * Localized human name for a mode — the badge's `title` / `aria-label`.
 * Reuses the `settings.mode_*` keys the colour settings already ship in
 * every locale rather than minting a parallel set.
 */
export function modeLabel(t: Translate, mode: TransportMode): string {
  const fallback = MODE_CONFIG[mode] ?? MODE_CONFIG.BUS;
  return t(`settings.mode_${mode.toLowerCase()}`, fallback.label);
}

/**
 * Single- or double-letter glyph shown on a badge when a route has no short
 * name. It is an abbreviation of the mode's name, so it is script-dependent:
 * a Cyrillic UI showing a Latin "B" for "аўтобус" reads as a foreign label,
 * not an abbreviation. Falls back to the Latin glyph for any locale that has
 * not declared one. Not every mode reaches here: see `MODE_PICTOGRAM`.
 */
export function modeGlyph(t: Translate, mode: TransportMode): string {
  const fallback = MODE_CONFIG[mode] ?? MODE_CONFIG.BUS;
  return t(`mode.glyph_${mode.toLowerCase()}`, fallback.icon);
}

/**
 * Modes drawn as a pictogram instead of a letter glyph.
 *
 * A letter glyph is an abbreviation of a word, so every locale has to mint
 * its own ("W", "P", "Пш") and a reader outside that language learns nothing
 * from it. Walking has a symbol that needs no language at all — the
 * pedestrian figure from street signage — so the badge shows that and the
 * mode name stays in the `title` / `aria-label`.
 *
 * Only modes with a symbol that is genuinely universal belong here; a mode
 * with no entry keeps its localized glyph.
 */
export const MODE_PICTOGRAM: Partial<Record<TransportMode, IconName>> = {
  WALK: "walk",
  BIKE: "bike",
  // No pictogram distinguishes a hired bike from your own one — the two share
  // the bicycle. The badge colour and the mode name in `title`/`aria-label`
  // carry the distinction, as they do for two bus sub-modes in one city.
  BIKE_SHARE: "bike",
  SCOOTER: "scooter",
  CAR: "car",
};

/**
 * The modes above are exactly the ones a rider takes under their own steam:
 * they never carry a route short name, so the badge showed their letter glyph
 * 100% of the time. A transit mode's glyph appears only when a feed omits the
 * route's short name, which is rare — those keep their localized letters.
 */
