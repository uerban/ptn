import { useId, useState } from "react";
import type { GuidedNetworkChoice, OnboardingPresetId } from "@pt/shared/privacy";
import type { RealtimeKind } from "@pt/shared/schedule-tile";
import { usePrivacyNamespace, useTranslation } from "../../i18n/index.ts";
import { describePreset } from "../../services/onboardingPresets.ts";
import type { StartMode } from "../../services/onboardingRecord.ts";
import type { SetupStringKey, SetupText } from "../../setup/setupStrings.ts";

export interface QuickSetupChoice {
  readonly presetId: OnboardingPresetId;
  readonly guidedChoice?: GuidedNetworkChoice;
}

export interface QuickSetupProps {
  readonly cityName: string;
  /** Kinds the city's server announced; `undefined` when not known yet. */
  readonly realtimeKinds: readonly RealtimeKind[] | undefined;
  readonly startMode: StartMode;
  readonly onStartModeChange: (mode: StartMode) => void;
  readonly onChoose: (choice: QuickSetupChoice) => void;
  /** Absent when the city cannot be changed from here. */
  readonly onChangeCity?: () => void;
  /** The city's transit data is not on this device yet, so starting downloads it. */
  readonly downloadsCity?: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly text: SetupText;
}

/** Recommended copy for what the city publishes (D8). */
export function recommendedSummaryKey(
  kinds: readonly RealtimeKind[] | undefined,
): SetupStringKey {
  if (!kinds) return "setup.recommended.generic";
  const departures = kinds.includes("departures");
  const alerts = kinds.includes("alerts");
  if (departures && alerts) return "setup.recommended.both";
  if (departures) return "setup.recommended.departuresOnly";
  if (alerts) return "setup.recommended.alertsOnly";
  return "setup.recommended.none";
}

const primaryButton =
  "min-h-11 w-full rounded-lg bg-accent px-4 py-2 text-left text-base font-medium text-white disabled:opacity-60";
const secondaryButton =
  "min-h-11 w-full rounded-lg border border-divider bg-surface-raised px-4 py-2 text-left text-base font-medium text-fg disabled:opacity-60";

export function QuickSetup(props: QuickSetupProps) {
  const { text, cityName, startMode } = props;
  const { t } = useTranslation();
  const privacyReady = usePrivacyNamespace();
  const ids = {
    heading: useId(),
    text: useId(),
    map: useId(),
    recommended: useId(),
    strict: useId(),
    question: useId(),
    live: useId(),
    ask: useId(),
  };
  const [customizing, setCustomizing] = useState(false);
  const [guided, setGuided] = useState<GuidedNetworkChoice | null>(null);
  const recommendedFlows = describePreset("recommended").allowedFlows;

  return (
    <section aria-labelledby={ids.heading} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-secondary">
        <span>{text("setup.quick.city", { city: cityName })}</span>
        {props.onChangeCity && (
          <button
            type="button"
            onClick={props.onChangeCity}
            disabled={props.busy}
            className="min-h-11 underline underline-offset-2 text-accent"
          >
            {text("setup.quick.changeCity")}
          </button>
        )}
        {props.downloadsCity && (
          <p className="basis-full text-sm text-fg-secondary">
            {text("setup.quick.download", { city: cityName })}
          </p>
        )}
      </div>

      <h1 tabIndex={-1} id={ids.heading} className="text-2xl font-semibold text-fg">
        {text("setup.quick.heading")}
      </h1>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{text("setup.presentation.legend")}</legend>
        {(["text", "map"] as const).map((mode) => (
          <label
            key={mode}
            className="flex min-h-11 items-start gap-3 rounded-lg border border-divider bg-surface-raised px-4 py-3 has-[:checked]:border-accent"
          >
            <input
              type="radio"
              name="setup-start-mode"
              value={mode}
              checked={startMode === mode}
              onChange={() => props.onStartModeChange(mode)}
              aria-describedby={ids[mode]}
              className="mt-1 accent-accent"
            />
            <span className="flex flex-col">
              <span className="text-base font-medium text-fg">
                {text(mode === "text" ? "setup.presentation.text" : "setup.presentation.map")}
              </span>
              <span id={ids[mode]} className="text-sm text-fg-secondary">
                {text(
                  mode === "text"
                    ? "setup.presentation.textDescription"
                    : "setup.presentation.mapDescription",
                )}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <button
          type="button"
          className={primaryButton}
          aria-describedby={ids.recommended}
          disabled={props.busy}
          onClick={() => props.onChoose({ presetId: "recommended" })}
        >
          {text("setup.recommended.action")}
        </button>
        <div id={ids.recommended} className="text-sm text-fg-secondary">
          <p>
            {text(recommendedSummaryKey(props.realtimeKinds), { city: cityName })}{" "}
            {text("setup.recommended.nearby")}
            {startMode === "map" && <> {text("setup.recommended.mapNote")}</>}
          </p>
        </div>
        <details className="text-sm text-fg-secondary">
          <summary className="min-h-11 cursor-pointer py-2 text-fg">
            {text("setup.recommended.detailsSummary")}
          </summary>
          <p>{text("setup.recommended.detailsIntro")}</p>
          {privacyReady && (
            <ul className="mt-1 list-disc pl-5">
              {recommendedFlows.map((flow) =>
                flow.dataFlow ? (
                  <li key={flow.flowId}>
                    <span className="font-medium text-fg">{t(flow.dataFlow.nameKey)}</span>
                    {": "}
                    {t(flow.dataFlow.purposeKey)}
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </details>
      </div>

      <div className="flex flex-col gap-1">
        <button
          type="button"
          className={secondaryButton}
          aria-describedby={ids.strict}
          disabled={props.busy}
          onClick={() => props.onChoose({ presetId: "strict" })}
        >
          {text("setup.strict.action")}
        </button>
        <p id={ids.strict} className="text-sm text-fg-secondary">
          {text("setup.strict.description")}
        </p>
        <details className="text-sm text-fg-secondary">
          <summary className="min-h-11 cursor-pointer py-2 text-fg">
            {text("setup.strict.detailsSummary")}
          </summary>
          <ul className="list-disc pl-5">
            <li>{text("setup.strict.history")}</li>
            <li>{text("setup.strict.personalization")}</li>
            <li>{text("setup.strict.export")}</li>
            <li>{text("setup.strict.links")}</li>
            <li>{text("setup.strict.cover")}</li>
            <li>{text("setup.strict.transitData")}</li>
          </ul>
          <p className="mt-1">{text("setup.strict.lowerLater")}</p>
        </details>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={customizing}
          disabled={props.busy}
          onClick={() => setCustomizing((open) => !open)}
          className="self-start min-h-11 text-base font-medium text-accent underline underline-offset-2"
        >
          {text("setup.customize.action")}
        </button>
        {customizing && (
          <div className="flex flex-col gap-2 rounded-lg border border-divider p-3">
            <p className="text-sm text-fg-secondary">
              {text(
                startMode === "text"
                  ? "setup.customize.summaryText"
                  : "setup.customize.summaryMap",
              )}
            </p>
            <fieldset className="flex flex-col gap-2">
              <legend id={ids.question} className="text-base font-medium text-fg">
                {text("setup.customize.question")}
              </legend>
              {(
                [
                  ["live-information", "live", "setup.customize.live", "setup.customize.liveDescription"],
                  ["ask-first", "ask", "setup.customize.ask", "setup.customize.askDescription"],
                ] as const
              ).map(([value, idKey, label, description]) => (
                <label key={value} className="flex min-h-11 items-start gap-3">
                  <input
                    type="radio"
                    name="setup-guided-network"
                    value={value}
                    checked={guided === value}
                    onChange={() => setGuided(value)}
                    aria-describedby={ids[idKey]}
                    className="mt-1 accent-accent"
                  />
                  <span className="flex flex-col">
                    <span className="text-base text-fg">{text(label)}</span>
                    <span id={ids[idKey]} className="text-sm text-fg-secondary">
                      {text(description)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className={secondaryButton}
              disabled={props.busy || guided === null}
              onClick={() =>
                guided && props.onChoose({ presetId: "customize", guidedChoice: guided })
              }
            >
              {text("setup.customize.continue")}
            </button>
          </div>
        )}
      </div>

      <p className="text-sm text-fg-muted">{text("setup.changeLater")}</p>
      <p className="text-sm text-fg-muted">{text("setup.personalEncrypted")}</p>
      {props.busy && (
        <p role="status" className="text-sm text-fg">
          {text("setup.starting")}
        </p>
      )}
      {props.error && (
        <p role="alert" className="text-sm text-fg">
          {props.error}
        </p>
      )}
    </section>
  );
}
