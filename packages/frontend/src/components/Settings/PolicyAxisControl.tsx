import { useState } from "react";
import {
  AXIS_STRICTNESS_ORDER,
  LEVEL_FLOORS,
  PRIVACY_LEVELS,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared/privacy";
import { usePolicy, usePrivacyStore } from "../../stores/privacyStore.ts";
import { useTranslation } from "../../i18n/index.ts";

interface Props<K extends keyof PrivacyPolicy> {
  axis: K;
  i18nKeyPrefix: string;
  interceptChange?: (next: PrivacyPolicy[K]) => Promise<boolean>;
}

function formatOption(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// For an option index, find the highest privacy level whose floor index for
// this axis is still <= the option index. That level is the maximum level
// at which this option remains selectable — i.e. to enable the option the
// user must drop their level to it (or lower).
function minLevelForOption<K extends keyof PrivacyPolicy>(
  axis: K,
  optionIdx: number,
  values: readonly PrivacyPolicy[K][],
): PrivacyLevel {
  let best: PrivacyLevel = PRIVACY_LEVELS[0];
  for (const level of PRIVACY_LEVELS) {
    const floorVal = LEVEL_FLOORS[level][axis];
    const floorIdx = values.indexOf(floorVal);
    if (floorIdx >= 0 && floorIdx <= optionIdx) best = level;
  }
  return best;
}

export function PolicyAxisControl<K extends keyof PrivacyPolicy>({
  axis,
  i18nKeyPrefix,
  interceptChange,
}: Props<K>) {
  const { t } = useTranslation();
  const policy = usePolicy();
  const level = usePrivacyStore((s) => s.level);
  const setOverride = usePrivacyStore((s) => s.setOverride);
  const clearOverride = usePrivacyStore((s) => s.clearOverride);
  const [revertKey, setRevertKey] = useState(0);

  const order = AXIS_STRICTNESS_ORDER[axis];
  const current = policy[axis];
  const floorValue = LEVEL_FLOORS[level][axis];

  if (order.kind === "numeric") {
    return (
      <div className="bg-surface-raised rounded-xl border border-divider px-4 py-3">
        <div className="text-sm text-fg">{t(`${i18nKeyPrefix}.current`, String(current))}</div>
      </div>
    );
  }

  const values = order.values as readonly PrivacyPolicy[K][];
  const floorIdx = values.indexOf(floorValue);

  const onSelect = async (value: PrivacyPolicy[K]) => {
    if (interceptChange) {
      const ok = await interceptChange(value);
      if (!ok) { setRevertKey((k) => k + 1); return; }
    }
    if (value === floorValue) {
      clearOverride(axis);
    } else {
      setOverride(axis, value);
    }
  };

  return (
    <div className="bg-surface-raised rounded-xl border border-divider">
      {values.map((value, idx) => {
        const disabled = idx < floorIdx;
        const optionKey = `${i18nKeyPrefix}.option.${formatOption(value)}`;
        const optionLabel = t(optionKey, formatOption(value));
        const minLevel = disabled
          ? minLevelForOption(axis, idx, values)
          : null;
        // lockedCopy is a template in both the namespace and the fallback —
        // see the i18n key taxonomy notes. Substitute after
        // resolution so translated copy gets the same treatment as English;
        // interpolating only the fallback left the {value}/{level}/{minLevel}
        // braces on screen whenever the privacy namespace resolved.
        const lockCopy = disabled
          ? t(
              `${i18nKeyPrefix}.lockedCopy`,
              "Locked to {value} by the {level} preset. Lower your privacy level to {minLevel} to enable it.",
            )
              .replace("{value}", formatOption(floorValue))
              .replace("{level}", level)
              .replace("{minLevel}", minLevel ?? "")
          : null;
        return (
          <label
            key={formatOption(value)}
            className={`flex items-start justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm text-fg">{optionLabel}</span>
              {lockCopy && (
                <span className="text-xs text-fg-muted italic">{lockCopy}</span>
              )}
            </span>
            <input
              key={`${formatOption(value)}-${revertKey}`}
              type="radio"
              name={`policy-axis-${String(axis)}`}
              value={formatOption(value)}
              checked={current === value}
              disabled={disabled}
              onChange={() => void onSelect(value)}
              className="accent-accent"
            />
          </label>
        );
      })}
    </div>
  );
}
