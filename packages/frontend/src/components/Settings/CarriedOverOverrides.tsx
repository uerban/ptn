import { useEffect } from "react";
import type { ProtectionAxis } from "@pt/shared/privacy";
import { useTranslation } from "../../i18n/index.ts";
import { useOnboardingStore } from "../../stores/onboardingStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

/**
 * Protections kept from a previous version of the app (for example the decoy
 * tile timer of the former Strict level). Each one is labelled as carried
 * over and can be removed; lowering the level below Strict removes them too.
 */
export function CarriedOverOverrides() {
  const { t } = useTranslation();
  const record = useOnboardingStore((s) => s.record);
  const load = useOnboardingStore((s) => s.load);
  const remove = useOnboardingStore((s) => s.removeCarriedOverOverride);
  const overrides = usePrivacyStore((s) => s.overrides);

  useEffect(() => {
    if (!record) load();
  }, [record, load]);

  const carried = Object.entries(record?.legacyOverrides ?? {}).filter(
    ([axis, value]) => overrides[axis as ProtectionAxis] === value,
  ) as [ProtectionAxis, unknown][];
  if (carried.length === 0) return null;

  return (
    <section aria-labelledby="carried-over-overrides" className="space-y-2">
      <h2
        id="carried-over-overrides"
        className="text-sm font-semibold text-fg-muted uppercase tracking-wider"
      >
        {t("privacy.carriedOver.title", "Carried over from your previous settings")}
      </h2>
      <p className="text-xs text-fg-secondary">
        {t(
          "privacy.carriedOver.description",
          "These protections were part of your privacy level before this update. They stay until you remove them or choose a level below Strict.",
        )}
      </p>
      <ul className="bg-surface-raised rounded-xl border border-divider">
        {carried.map(([axis, value]) => {
          const title = t(`privacy.axis.${axis}.title`, axis);
          return (
            <li
              key={axis}
              className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider last:border-b-0"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-fg">{title}</span>
                <span className="text-xs text-fg-muted">
                  {t(`privacy.axis.${axis}.option.${String(value)}`, String(value))}
                  {" · "}
                  {t("privacy.carriedOver.label", "Carried over")}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(axis)}
                aria-label={t("privacy.carriedOver.removeLabel", "Remove {title}").replace(
                  "{title}",
                  title,
                )}
                className="text-sm text-accent underline"
              >
                {t("privacy.carriedOver.remove", "Remove")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
