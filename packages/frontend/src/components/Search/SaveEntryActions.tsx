import type { PrivacyPolicy } from "@pt/shared";
import { usePolicy } from "../../stores/privacyStore.ts";
import { canExportSaves, canShareSaves } from "../../services/saves.ts";
import { useTranslation } from "../../i18n/index.ts";

export interface SaveEntryActionsProps {
  saveId: string;
  onExport?: (saveId: string) => void;
  onShare?: (saveId: string) => void;
  /** Test hook: override the policy axis (bypasses store lookup). */
  axisOverride?: PrivacyPolicy["savesEncryption"];
}

export function SaveEntryActions({
  saveId,
  onExport,
  onShare,
  axisOverride,
}: SaveEntryActionsProps) {
  const policy = usePolicy();
  const axis = axisOverride ?? policy.savesEncryption;
  const exportVisible = canExportSaves(axis);
  const shareVisible = canShareSaves(axis);
  const { t } = useTranslation();

  if (!exportVisible && !shareVisible) return null;

  return (
    <div
      role="group"
      aria-label={t("saves.actions", "Save actions")}
      className="flex items-center gap-2"
    >
      {exportVisible ? (
        <button
          type="button"
          data-action="export"
          onClick={() => onExport?.(saveId)}
          className="text-xs px-2 py-1 rounded border border-divider
            hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none"
        >
          {t("saves.export", "Export")}
        </button>
      ) : null}
      {shareVisible ? (
        <button
          type="button"
          data-action="share"
          onClick={() => onShare?.(saveId)}
          className="text-xs px-2 py-1 rounded border border-divider
            hover:bg-surface-overlay focus:bg-surface-overlay focus:outline-none"
        >
          {t("saves.share", "Share")}
        </button>
      ) : null}
    </div>
  );
}
