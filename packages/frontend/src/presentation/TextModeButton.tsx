import { Icon } from "../components/Icon.tsx";
import { usePresentationText } from "../i18n/presentationStrings.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";

/**
 * The map screen's way back to text. On a temporary map (opened from Text
 * mode) it is **Back to text**, which returns without touching the saved
 * starting view; in Map mode it switches the starting view to Text mode.
 */
export function TextModeButton({ onBackToText }: { onBackToText?: () => void }) {
  const text = usePresentationText();
  if (onBackToText) {
    return (
      <button
        type="button"
        onClick={onBackToText}
        className="flex items-center gap-1 px-3 py-2 rounded-lg bg-surface-raised shadow-1 hover:bg-surface-overlay text-sm font-medium text-fg"
        data-testid="back-to-text-btn"
      >
        <Icon name="arrow-left" size={18} className="text-fg-secondary" />
        <span>{text("presentation.backToText")}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => useSettingsStore.getState().setScheduleMode(true)}
      className="p-2 rounded-lg bg-surface-raised shadow-1 hover:bg-surface-overlay"
      aria-label={text("presentation.switchToText")}
      title={text("presentation.switchToText")}
      data-testid="show-schedule-btn"
    >
      <Icon name="clock" className="text-fg-secondary" />
    </button>
  );
}
