import { useTranslation } from "../../../i18n/index.ts";

interface Props {
  /** "tight" = short wait margin; "miss" = live delay already consumed it. */
  kind: "tight" | "miss";
  compact?: boolean;
}

/** Warns that a transfer is short enough to be lost to typical delays. */
export function TransferRiskBadge({ kind, compact = false }: Props) {
  const { t } = useTranslation();
  const label =
    kind === "miss"
      ? compact
        ? t("route.risk_miss_short", "MISS")
        : t("route.risk_miss", "May miss transfer")
      : compact
        ? t("route.risk_tight_short", "TIGHT")
        : t("route.risk_tight", "Tight transfer");
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-danger bg-danger/10 text-danger font-mono font-bold tracking-wider
        ${compact ? "px-1 py-px text-[9px]" : "px-1.5 py-0.5 text-[10px]"}`}
    >
      <span aria-hidden>{kind === "miss" ? "→!" : "◷"}</span>
      {label}
    </span>
  );
}
