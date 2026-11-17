import { useId, useState } from "react";
import {
  presetDecisions,
  type GuidedNetworkChoice,
  type OnboardingPresetId,
} from "@pt/shared/privacy";
import type { RealtimeKind } from "@pt/shared/schedule-tile";
import { usePrivacyNamespace, useTranslation } from "../../i18n/index.ts";
import { findDataFlow } from "../../privacy/dataFlowRegistry.ts";
import type { StartMode } from "../../services/onboardingRecord.ts";
import type { SetupStringKey, SetupText } from "../../setup/setupStrings.ts";
import { getBasemapProvider } from "../../config/basemapProviders.ts";
import { SETUP_DETAILED_MAP, setupAsksMap } from "../../setup/setupMapChoice.ts";

/** The flows Recommended turns on, with their shared descriptions. */
const RECOMMENDED_FLOWS = Object.entries(
  presetDecisions("recommended"),
).flatMap(([flowId, value]) => {
  const flow = value === "allowed" ? findDataFlow(flowId) : undefined;
  return flow ? [flow] : [];
});

export interface QuickSetupChoice {
  readonly presetId: OnboardingPresetId;
  readonly guidedChoice?: GuidedNetworkChoice;
  /** Answer to the map choice; absent when it was not shown. */
  readonly detailedMap?: boolean;
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

/**
 * Recommended-setup copy for the live data the city publishes: both,
 * departures only, alerts only, none, or not yet known.
 */
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

const continueButton =
  "min-h-14 w-full rounded-xl bg-accent px-4 py-3 text-center text-lg [overflow-wrap:anywhere] font-semibold text-white disabled:opacity-60";
/** One look for every choice card on this page: equal size, no highlight. */
const choiceCard =
  "flex min-h-12 items-start gap-3 rounded-lg border border-divider bg-surface-raised px-3 py-2 has-[:checked]:border-accent has-[:checked]:ring-1 has-[:checked]:ring-accent";
const whySummary = "min-h-11 cursor-pointer py-2 text-sm font-medium text-fg";

export type SetupLevel = "recommended" | "strict" | "customize";

const LEVEL_LABEL: Record<SetupLevel, SetupStringKey> = {
  recommended: "setup.level.recommended",
  strict: "setup.level.strict",
  customize: "setup.level.custom",
};
const LEVEL_CONTINUE: Record<SetupLevel, SetupStringKey> = {
  recommended: "setup.level.continueRecommended",
  strict: "setup.level.continueStrict",
  customize: "setup.level.continueCustom",
};

/**
 * The setup page: start mode, a visible privacy level (Recommended is
 * preselected; every option has the same weight and Continue names the level
 * it applies), and one Continue that stays on screen.
 */
export function QuickSetup(props: QuickSetupProps) {
  const { text, cityName, startMode } = props;
  const { t } = useTranslation();
  const privacyReady = usePrivacyNamespace();
  const ids = {
    heading: useId(),
    mode: useId(),
    recommended: useId(),
    strict: useId(),
    customize: useId(),
    customPending: useId(),
    live: useId(),
    ask: useId(),
    minimal: useId(),
    detailed: useId(),
  };
  // Kept while Strict hides the map choice, so switching back restores it.
  const [mapPick, setMapPick] = useState<"minimal" | "detailed">("minimal");
  const providerName =
    getBasemapProvider(SETUP_DETAILED_MAP.providerId)?.name ?? SETUP_DETAILED_MAP.providerId;
  const [level, setLevel] = useState<SetupLevel>("recommended");
  const [guided, setGuided] = useState<GuidedNetworkChoice | null>(null);
  const pending = level === "customize" && guided === null;

  const levelLine = (value: SetupLevel): string =>
    value === "recommended"
      ? text(recommendedSummaryKey(props.realtimeKinds), { city: cityName })
      : text(value === "strict" ? "setup.level.strictLine" : "setup.level.customLine");

  const asksMap = setupAsksMap(level, startMode);
  const proceed = () => {
    const map = asksMap ? { detailedMap: mapPick === "detailed" } : {};
    if (level === "customize") {
      if (guided) props.onChoose({ presetId: "customize", guidedChoice: guided, ...map });
      return;
    }
    props.onChoose({ presetId: level, ...map });
  };

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
        {text("setup.quick.briefHeading")}
      </h1>

      {/* Start mode: compact, because the map choice depends on it. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-base font-medium text-fg">
          {text("setup.quick.heading")}
        </legend>
        <div className="flex gap-2">
          {(["text", "map"] as const).map((mode) => (
            <label key={mode} className={`${choiceCard} flex-1 items-center`}>
              <input
                type="radio"
                name="setup-start-mode"
                value={mode}
                checked={startMode === mode}
                onChange={() => props.onStartModeChange(mode)}
                aria-describedby={ids.mode}
                className="shrink-0 accent-accent"
              />
              <span className="min-w-0 text-base font-medium text-fg [overflow-wrap:anywhere]">
                {text(mode === "text" ? "setup.presentation.text" : "setup.presentation.map")}
              </span>
            </label>
          ))}
        </div>
        <p id={ids.mode} className="text-sm text-fg-secondary">
          {text(
            startMode === "text"
              ? "setup.presentation.textDescription"
              : "setup.presentation.mapDescription",
          )}
        </p>
      </fieldset>

      {/* Privacy level: visible, equal options; picking one never moves focus. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium text-fg">
          {text("setup.level.legend")}
        </legend>
        {(["recommended", "strict", "customize"] as const).map((value) => (
          <label key={value} className={choiceCard}>
            <input
              type="radio"
              name="setup-level"
              value={value}
              checked={level === value}
              onChange={() => setLevel(value)}
              aria-describedby={ids[value]}
              className="mt-1 shrink-0 accent-accent"
            />
            <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
              <span className="text-base font-medium text-fg">{text(LEVEL_LABEL[value])}</span>
              <span id={ids[value]} aria-hidden="true" className="text-sm text-fg-secondary">
                {levelLine(value)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {level === "customize" && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-divider p-3">
          <legend className="px-1 text-base font-medium text-fg">
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
                className="mt-1 shrink-0 accent-accent"
              />
              <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
                <span className="text-base text-fg">{text(label)}</span>
                <span id={ids[idKey]} aria-hidden="true" className="text-sm text-fg-secondary">
                  {text(description)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <details className="text-sm text-fg-secondary">
        <summary className={whySummary}>{text("setup.level.why")}</summary>
        <div className="max-h-[40dvh] space-y-2 overflow-y-auto pb-1">
          <p className="font-medium text-fg">{text("setup.level.recommended")}</p>
          <p>{text("setup.recommended.detailsIntro")}</p>
          {privacyReady && (
            <ul className="list-disc pl-5 [overflow-wrap:anywhere]">
              {RECOMMENDED_FLOWS.map((flow) => (
                <li key={flow.id}>
                  <span className="font-medium text-fg">{t(flow.nameKey)}</span>
                  {": "}
                  {t(flow.purposeKey)}
                </li>
              ))}
            </ul>
          )}
          <p className="font-medium text-fg">{text("setup.level.strict")}</p>
          <p>{text("setup.strict.description")}</p>
          <ul className="list-disc pl-5 [overflow-wrap:anywhere]">
            <li>{text("setup.strict.history")}</li>
            <li>{text("setup.strict.personalization")}</li>
            <li>{text("setup.strict.export")}</li>
            <li>{text("setup.strict.links")}</li>
            <li>{text("setup.strict.cover")}</li>
            <li>{text("setup.strict.transitData")}</li>
          </ul>
          <p>{text("setup.personalEncrypted")}</p>
        </div>
      </details>

      {/* Map choice: Map mode only. Under Strict it is one line, not a
          disabled option: Strict keeps the map on this device. */}
      {startMode === "map" && !asksMap && (
        <p className="text-sm text-fg-secondary">{text("setup.map.strictLine")}</p>
      )}
      {asksMap && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-base font-medium text-fg">
              {text("setup.map.legend")}
            </legend>
            {(["minimal", "detailed"] as const).map((value) => (
              <label key={value} className={choiceCard}>
                <input
                  type="radio"
                  name="setup-map"
                  value={value}
                  checked={mapPick === value}
                  onChange={() => setMapPick(value)}
                  aria-describedby={ids[value]}
                  className="mt-1 shrink-0 accent-accent"
                />
                <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
                  <span className="text-base font-medium text-fg">
                    {text(value === "minimal" ? "setup.map.minimal" : "setup.map.detailed")}
                  </span>
                  <span id={ids[value]} className="text-sm text-fg-secondary">
                    {value === "minimal"
                      ? text("setup.map.minimalLine")
                      : text("setup.map.detailedLine", { provider: providerName })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <details className="text-sm text-fg-secondary">
            <summary className={whySummary}>{text("setup.map.why")}</summary>
            <div className="max-h-[40dvh] overflow-y-auto pb-1">
              <p>{text("setup.map.whyBody", { provider: providerName })}</p>
            </div>
          </details>
        </>
      )}

      {/* Only Continue and its messages stick, so large text keeps room to read. */}
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 bg-surface px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className={continueButton}
          disabled={props.busy || pending}
          aria-describedby={pending ? ids.customPending : undefined}
          onClick={proceed}
        >
          {text(LEVEL_CONTINUE[level])}
        </button>
        {pending && (
          <p id={ids.customPending} className="text-sm text-fg">
            {text("setup.level.customPending")}
          </p>
        )}
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
      </div>
      <p className="text-sm text-fg-muted">{text("setup.changeLater")}</p>
    </section>
  );
}
