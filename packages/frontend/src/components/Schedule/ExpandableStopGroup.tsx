import { useState } from "react";
import type { StopGroupRecord } from "../../db/index.ts";
import type { DirectionLabel } from "../../services/directionResolver.ts";
import { useTranslation } from "../../i18n/index.ts";
import { StopCard } from "./StopCard.tsx";

export interface ExpandableStopGroupProps {
  group: StopGroupRecord;
  distanceMeters: number;
  lineLabels: string[];
  lineColors: Map<string, string>;
  directionLabels: DirectionLabel[];
  platformCodes: Map<string, string>;
  stopNames: Map<string, string>;
  onStopSelect: (stopId: string) => void;
}

export function ExpandableStopGroup({
  group,
  distanceMeters,
  lineLabels,
  lineColors,
  directionLabels,
  platformCodes,
  stopNames,
  onStopSelect,
}: ExpandableStopGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const substopsId = `group-${group.groupId}-stops`;

  function handleExpand() {
    setExpanded((prev) => !prev);
  }

  // i18n template: "{name}, {count} platforms" — codebase uses simple {token}
  // placeholders with .replace() (no i18next interpolation runtime).
  const toggleAriaLabel = t("schedule.group_toggle", "{name}, {count} platforms")
    .replace("{name}", group.name)
    .replace("{count}", String(group.stopIds.length));

  return (
    <div data-testid="expandable-stop-group">
      {/* Single semantic toggle: the chevron <button> inside StopCard owns
          aria-expanded / aria-controls. The whole row has exactly one
          interactive control (no nested-interactive a11y violation). */}
      <div data-testid="stop-group-header">
        <StopCard
          group={group}
          distanceMeters={distanceMeters}
          lineLabels={lineLabels}
          lineColors={lineColors}
          directionLabels={directionLabels}
          platformCodes={platformCodes}
          onSelect={() => {
            // Card-level select is unused in expandable mode (the chevron
            // button is the toggle). Keep the prop satisfied.
          }}
          expandable={group.stopIds.length > 1}
          onExpand={handleExpand}
          toggleAriaExpanded={expanded}
          toggleAriaControls={substopsId}
          toggleAriaLabel={toggleAriaLabel}
          toggleTestId="group-expand-toggle"
        />
      </div>

      {/* Sub-stops list */}
      {expanded && (
        <ul
          id={substopsId}
          data-testid="substops-list"
          className="ml-4 mt-0.5 space-y-0.5 list-none p-0"
          role="list"
          aria-label={t("schedule.platforms", "Platforms")}
        >
          {group.stopIds.map((stopId) => {
            const platformCode = platformCodes.get(stopId);
            return (
              <li
                key={stopId}
                data-testid="substop-item"
              >
                <button
                  type="button"
                  data-testid={`substop-btn-${stopId}`}
                  aria-label={platformCode
                    ? `${t("stop.platform", "Platform")} ${platformCode}`
                    : stopId}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-overlay border border-divider hover:bg-surface-overlay/80 active:bg-surface-overlay/60 transition-colors text-left"
                  onClick={() => onStopSelect(stopId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onStopSelect(stopId);
                    }
                  }}
                >
                  {platformCode && (
                    <span
                      data-testid="substop-platform-badge"
                      className="text-[10px] text-fg-muted bg-surface-raised border border-divider rounded px-1.5 py-0.5 shrink-0"
                    >
                      {platformCode}
                    </span>
                  )}
                  <span className="text-sm text-fg-secondary truncate">
                    {platformCode
                      ? `${t("stop.platform", "Platform")} ${platformCode}`
                      : stopNames.get(stopId) ?? group.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
