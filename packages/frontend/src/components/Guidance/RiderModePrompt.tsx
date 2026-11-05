import type { RiderCandidate } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { Icon } from "../Icon.tsx";

interface RiderModePromptProps {
  candidates: RiderCandidate[];
  onSelect: (candidate: RiderCandidate) => void;
  onDismiss: () => void;
}

export function RiderModePrompt({
  candidates,
  onSelect,
  onDismiss,
}: RiderModePromptProps) {
  const { t, formattingLocale } = useTranslation();

  if (candidates.length === 0) return null;

  return (
    <div
      data-testid="rider-mode-prompt"
      className="bg-surface-raised rounded-2xl shadow-2 p-4 w-80"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg">
          {t("guidance.boarding_prompt", "Are you boarding?")}
        </h3>
        <button
          onClick={onDismiss}
          className="p-1 rounded-full hover:bg-surface-overlay"
          aria-label="Dismiss"
        >
          <Icon name="close" size={16} className="text-fg-muted" />
        </button>
      </div>

      <div className="space-y-2">
        {candidates.map((c) => {
          const depTime = new Date(c.departureTime);
          const formatted = depTime.toLocaleTimeString(formattingLocale, {
            hour: "2-digit",
            minute: "2-digit",
          });

          return (
            <button
              key={c.tripId}
              onClick={() => onSelect(c)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg
                bg-surface-overlay border border-divider
                hover:border-accent transition-colors text-left"
            >
              <span
                className="text-xs font-bold min-w-[2rem] text-center rounded px-1.5 py-0.5 shrink-0 text-badge-text"
                style={{
                  "--route-color": c.routeColor
                    ? (c.routeColor.startsWith("#") ? c.routeColor : `#${c.routeColor}`)
                    : "#6b7280",
                  backgroundColor: "var(--route-color)",
                } as React.CSSProperties}
              >
                {c.routeShortName}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg truncate">{c.headsign}</div>
              </div>
              <span className="text-xs text-fg-muted shrink-0">{formatted}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
