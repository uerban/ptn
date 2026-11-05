import type { KeyboardEvent } from "react";
import type { StopGroupRecord } from "../../db/index.ts";
import type { DirectionLabel } from "../../services/directionResolver.ts";
import { useTranslation } from "../../i18n/index.ts";
import { contrastTextColor } from "../../utils/routeColor.ts";

const MAX_DEPARTURE_CHIPS = 3;

export interface StopCardProps {
  group: StopGroupRecord;
  distanceMeters: number;
  lineLabels: string[];
  lineColors: Map<string, string>;
  directionLabels: DirectionLabel[];
  platformCodes?: Map<string, string>;
  onSelect: () => void;
  expandable?: boolean;
  onExpand?: () => void;
  /**
   * Optional toggle attributes for the expand button. When `expandable` is
   * true and these are provided, the chevron <button> serves as a single
   * aria-expanded toggle (used by ExpandableStopGroup). Without them the
   * chevron behaves as a plain "expand details" button (legacy callers).
   */
  toggleAriaExpanded?: boolean;
  toggleAriaControls?: string;
  toggleAriaLabel?: string;
  /**
   * Optional override for the chevron button's data-testid. Defaults to
   * "expand-btn" for the standalone StopCard contract; ExpandableStopGroup
   * overrides this to "group-expand-toggle" so existing test selectors
   * continue to address the single semantic toggle.
   */
  toggleTestId?: string;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

export function StopCard({
  group,
  distanceMeters,
  lineLabels,
  lineColors,
  directionLabels,
  platformCodes,
  onSelect,
  expandable,
  onExpand,
  toggleAriaExpanded,
  toggleAriaControls,
  toggleAriaLabel,
  toggleTestId,
}: StopCardProps) {
  const { t } = useTranslation();

  const isTransfer = lineLabels.length >= 3;
  const visibleLines = lineLabels.slice(0, MAX_DEPARTURE_CHIPS);
  const overflowCount = lineLabels.length - MAX_DEPARTURE_CHIPS;

  // Collect platform codes for display (unique values)
  const platformEntries: string[] = [];
  if (platformCodes && platformCodes.size > 0) {
    const seen = new Set<string>();
    for (const code of platformCodes.values()) {
      if (!seen.has(code)) {
        seen.add(code);
        platformEntries.push(code);
      }
    }
  }

  // Build aria-label sentence
  const directionParts = directionLabels.map((d) => `toward ${d.label}`);
  const linePart = lineLabels.length > 0 ? `lines ${lineLabels.join(", ")}` : "";
  const transferPart = isTransfer ? t("stop.transfer_point", "transfer point") : "";
  const distancePart = `${formatDistance(distanceMeters)} away`;

  const ariaLabelParts = [group.name, transferPart, distancePart, linePart, ...directionParts].filter(Boolean);
  const ariaLabel = ariaLabelParts.join(", ");

  const stopSummaryId = `stop-${group.groupId}-summary`;

  // When `expandable` is true the chevron <button> is the single interactive
  // control for the row, so the outer card must NOT also be a focusable
  // role="button" — that would be a nested-interactive a11y violation.
  // In the non-expandable case the card itself remains the button.
  const interactiveProps = expandable
    ? {}
    : {
        role: "button",
        tabIndex: 0,
        "aria-label": ariaLabel,
        "aria-describedby": stopSummaryId,
        onClick: onSelect,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        },
      };

  return (
    <div
      data-testid="stop-card"
      {...interactiveProps}
      className={`bg-surface-overlay rounded-lg mx-2 mb-1.5 border border-divider transition-colors${expandable ? "" : " cursor-pointer hover:bg-surface-overlay/80 active:bg-surface-overlay/60"}`}
      style={{ padding: "var(--variant-row-pad)", minHeight: "var(--variant-row-min-height)" }}
    >
      <span id={stopSummaryId} className="sr-only">
        {group.name}, {lineLabels.length} {t("stop.lines", "lines")}, {formatDistance(distanceMeters)} {t("stop.away", "away")}
      </span>
      {/* Header row: name + distance */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            data-testid="stop-name"
            className="font-semibold text-fg truncate"
            style={{ fontSize: "var(--variant-primary-text-size)" }}
          >
            {group.name}
          </span>
          {isTransfer && (
            <span
              data-testid="transfer-badge"
              className="text-warning bg-warning/10 px-1.5 py-0.5 rounded-full shrink-0"
              style={{ fontSize: "var(--variant-meta-text-size)" }}
            >
              {lineLabels.length}+ {t("stop.lines", "lines")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            data-testid="stop-distance"
            className="text-fg-muted"
            style={{ fontSize: "var(--variant-meta-text-size)" }}
          >
            {formatDistance(distanceMeters)}
          </span>
          {expandable && (
            <button
              type="button"
              data-testid={toggleTestId ?? "expand-btn"}
              aria-expanded={toggleAriaExpanded}
              aria-controls={toggleAriaControls}
              aria-label={toggleAriaLabel ?? t("stop.expand", "Expand stop details")}
              onClick={(e) => {
                e.stopPropagation();
                onExpand?.();
              }}
              onKeyDown={(e) => {
                // Native <button> dispatches click on Space/Enter, but
                // testing-library's fireEvent.keyDown doesn't, so handle
                // these explicitly to keep keyboard-only tests honest.
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onExpand?.();
                }
              }}
              className="p-0.5 rounded hover:bg-surface-overlay"
            >
              <svg
                className="w-4 h-4 text-fg-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Line badges row */}
      {visibleLines.length > 0 && (
        <div data-testid="line-badges" className="flex items-center gap-1 mt-1.5 flex-wrap">
          {visibleLines.map((label) => {
            const color = lineColors.get(label);
            return (
              <span
                key={label}
                data-testid="line-badge"
                className={`text-xs font-bold rounded px-1.5 py-0.5${color ? "" : " bg-surface-raised border border-divider text-fg"}`}
                style={color ? {
                  backgroundColor: color,
                  color: contrastTextColor(color),
                } : undefined}
              >
                {label}
              </span>
            );
          })}
          {overflowCount > 0 && (
            <span
              data-testid="line-overflow"
              className="text-xs text-fg-muted"
            >
              +{overflowCount}
            </span>
          )}
        </div>
      )}

      {/* Platform codes */}
      {platformEntries.length > 0 && (
        <div data-testid="platform-codes" className="flex items-center gap-1 mt-1 flex-wrap">
          {platformEntries.map((code) => (
            <span
              key={code}
              data-testid="platform-badge"
              className="text-fg-muted bg-surface-raised border border-divider rounded px-1 py-0.5"
              style={{ fontSize: "var(--variant-meta-text-size)" }}
            >
              {code}
            </span>
          ))}
        </div>
      )}

      {/* Direction labels */}
      {directionLabels.length > 0 && (
        <div data-testid="direction-labels" className="flex flex-col gap-0.5 mt-1">
          {directionLabels.map((dir, i) => (
            <div
              key={i}
              className="flex items-center gap-1 text-fg-secondary"
              style={{ fontSize: "var(--variant-meta-text-size)" }}
            >
              {dir.routeLabels.length > 0 && (
                <span
                  data-testid="direction-route-badge"
                  className="font-bold bg-surface-raised border border-divider rounded px-1 py-0.5 text-fg shrink-0"
                  style={{ fontSize: "var(--variant-meta-text-size)" }}
                >
                  {dir.routeLabels[0]}
                </span>
              )}
              <span data-testid="direction-label">
                {t("stop.toward", "toward")} {dir.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
