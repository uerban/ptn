import { useTranslation } from "../../i18n/index.ts";
import { OptionalStorageChoice } from "./OptionalStorageChoice.tsx";
import { PersonalStorageDetail, PersonalStorageNotice } from "./PersonalStorageNotice.tsx";

export function PrivacyStorageSettings() {
  const { t } = useTranslation();
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-fg-muted">
        {t("privacy.optional.heading", "Optional local memory")}
      </h2>
      <p className="mb-3 text-xs text-fg-muted">
        {t(
          "privacy.optional.intro",
          "PTN works without these. If you enable one, its data stays in this browser and you can stop and delete it at any time.",
        )}
      </p>
      <PersonalStorageDetail />
      <PersonalStorageNotice showProgress />
      <div className="space-y-3">
        <OptionalStorageChoice
          category="recents"
          title={t("privacy.optional.recents_title", "Recent places")}
          description={t(
            "privacy.optional.recents_desc",
            "Keep origins and destinations for quicker searches. Your privacy level controls encryption and retention.",
          )}
        />
        <OptionalStorageChoice
          category="viewport"
          title={t("privacy.optional.viewport_title", "Last map area")}
          description={t(
            "privacy.optional.viewport_desc",
            "Reopen the map near where you left it. PTN stores only the precision your privacy level permits.",
          )}
        />
        <OptionalStorageChoice
          category="personalization"
          title={t("privacy.optional.personalization_title", "Helpful stop suggestions")}
          description={t(
            "privacy.optional.personalization_desc",
            "Use recent stop taps to rank likely stops on this device. Counts expire after 30 or 7 days; stricter levels turn this off.",
          )}
        />
      </div>
    </section>
  );
}
