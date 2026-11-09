import { useState } from "react";
import type { ProtectionPolicy } from "@pt/shared/privacy";
import { useTranslation } from "../../i18n/index.ts";
import {
  usePrivacyChoicesStore,
  type OptionalStorageCategory,
} from "../../stores/privacyChoicesStore.ts";
import { usePolicy } from "../../stores/privacyStore.ts";
import {
  withdrawPersonalization,
  withdrawRecents,
  withdrawViewport,
} from "../../services/privacyChoices.ts";

export interface OptionalStorageChoiceProps {
  category: OptionalStorageCategory;
  title: string;
  description: string;
  presentation?: "contextual" | "settings";
  /** Test seam; defaults to the category's production deletion function. */
  cleanup?: () => Promise<void>;
}

function policyPermits(
  category: OptionalStorageCategory,
  policy: ProtectionPolicy,
): boolean {
  switch (category) {
    case "recents":
      return policy.recentsEncryption !== "off";
    case "viewport":
      return policy.viewportPersistence !== "off";
    case "personalization":
      return policy.stopUsageRetention !== "off";
  }
}

function defaultCleanup(category: OptionalStorageCategory): () => Promise<void> {
  switch (category) {
    case "recents":
      return async () =>
        (await import("../../services/optionalStorageData.ts")).clearRecentsData();
    case "viewport":
      return async () =>
        (await import("../../services/optionalStorageData.ts")).clearViewportData();
    case "personalization":
      return async () =>
        (await import("../../services/optionalStorageData.ts")).clearPersonalizationData();
  }
}

async function withdrawCategory(
  category: OptionalStorageCategory,
  cleanup: () => Promise<void>,
): Promise<void> {
  switch (category) {
    case "recents":
      return withdrawRecents(cleanup);
    case "viewport":
      return withdrawViewport(cleanup);
    case "personalization":
      return withdrawPersonalization(cleanup);
  }
}

export function OptionalStorageChoice({
  category,
  title,
  description,
  presentation = "settings",
  cleanup,
}: OptionalStorageChoiceProps) {
  const { t } = useTranslation();
  const choice = usePrivacyChoicesStore((state) => state.choices[category]);
  const setChoice = usePrivacyChoicesStore((state) => state.setChoice);
  const policy = usePolicy();
  const permitted = policyPermits(category, policy);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (presentation === "contextual" && choice !== "unset") {
    return status ? (
      <p role="status" className="px-4 py-2 text-xs text-fg-muted">
        {status}
      </p>
    ) : null;
  }

  // A contextual prompt is never offered for something the protection level
  // forbids; Settings explains that it needs a lower level.
  if (presentation === "contextual" && !permitted) return null;

  function remember(): void {
    setError(null);
    setStatus(t("privacy.optional.enabled_status", "This browser will remember it."));
    setChoice(category, "enabled");
  }

  function decline(): void {
    setError(null);
    setStatus(t("privacy.optional.disabled_status", "Nothing will be remembered."));
    setChoice(category, "disabled");
  }

  async function withdraw(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await withdrawCategory(category, cleanup ?? defaultCleanup(category));
      setStatus(
        t(
          "privacy.optional.withdrawn_status",
          "Remembering stopped and existing data was deleted.",
        ),
      );
    } catch {
      setError(
        t(
          "privacy.optional.withdraw_error",
          "Remembering is off, but some existing data could not be deleted. Try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const stateCopy = !permitted
    ? choice === "enabled"
      ? t("privacy.optional.state_paused", "Paused by your privacy level")
      : t(
          "privacy.optional.state_unavailable",
          "Unavailable at your current privacy level",
        )
    : choice === "enabled"
      ? t("privacy.optional.state_on", "On for this browser")
      : choice === "disabled"
        ? t("privacy.optional.state_off", "Off for this browser")
        : t("privacy.optional.state_unset", "Not decided yet");

  return (
    <section
      className={
        presentation === "contextual"
          ? "mx-3 my-2 rounded-lg border border-divider bg-surface-raised px-3 py-2"
          : "rounded-xl border border-divider bg-surface-raised px-4 py-3"
      }
      aria-label={title}
    >
      <div
        className={
          presentation === "contextual"
            ? "flex flex-col items-stretch gap-2"
            : "flex items-start justify-between gap-3"
        }
      >
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          <p className="text-xs text-fg-muted">{description}</p>
          {presentation === "settings" && (
            <p className="mt-1 text-xs font-medium text-fg-secondary">
              {stateCopy}
            </p>
          )}
        </div>
        <div
          className={
            presentation === "contextual"
              ? "flex flex-wrap justify-start gap-2"
              : "flex shrink-0 flex-wrap justify-end gap-2"
          }
        >
          {choice === "enabled" ? (
            <button
              type="button"
              onClick={() => void withdraw()}
              disabled={busy}
              className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50"
            >
              {busy
                ? t("privacy.optional.stopping", "Stopping…")
                : t("privacy.optional.stop", "Stop remembering")}
            </button>
          ) : (
            <button
              type="button"
              onClick={remember}
              disabled={!permitted}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-badge-text disabled:opacity-50"
            >
              {t("privacy.optional.remember", "Remember")}
            </button>
          )}
          {choice === "unset" && (
            <button
              type="button"
              onClick={decline}
              className="rounded-lg border border-divider px-3 py-1.5 text-xs font-medium text-fg-secondary"
            >
              {t("privacy.optional.no_thanks", "No thanks")}
            </button>
          )}
        </div>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {status && presentation === "settings" && (
          <p role="status" className="mt-2 text-xs text-accent">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
