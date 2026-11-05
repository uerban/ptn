import type { TransportMode } from "@pt/shared";
import { Icon } from "./Icon.tsx";
import { useTranslation } from "../i18n/index.ts";
import { MODE_PICTOGRAM, modeGlyph } from "../utils/modeLabels.ts";

interface Props {
  mode: TransportMode;
  /**
   * Pictogram size. Defaults to `1.35em` so it tracks the badge's font size
   * the way the letter glyph it replaces did. A shade larger than the glyph's
   * cap height: a figure needs more room than a letter to stay legible.
   */
  size?: number | string;
}

/**
 * What a mode badge shows in place of a route short name: a pictogram for the
 * modes that have a universal one, else the localized letter glyph.
 *
 * The pictogram is decorative — `Icon` marks it `aria-hidden` — because every
 * badge that renders this already carries the mode name as its accessible
 * name. Colour comes from `currentColor`, so it follows the badge's contrast
 * pick like text did.
 */
export function ModeGlyph({ mode, size = "1.35em" }: Props) {
  const { t } = useTranslation();
  const pictogram = MODE_PICTOGRAM[mode];
  if (pictogram) return <Icon name={pictogram} size={size} />;
  return <>{modeGlyph(t, mode)}</>;
}
