import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CityConfig } from "../../config/cities.ts";
import { useTranslation } from "../../i18n/index.ts";
import { LanguagePicker } from "../Settings/LanguagePicker.tsx";
import {
  getRealtimeAvailability,
  subscribeRealtimeAvailability,
} from "../../services/realtimeAvailability.ts";
import type { StartMode } from "../../services/onboardingRecord.ts";
import { chooseSetupCity, completeSetup } from "../../setup/completeSetup.ts";
import { useSetupText } from "../../setup/setupStrings.ts";
import type { SetupMode } from "../../setup/startupPlan.ts";
import { CitySelection, type CatalogStatus } from "./CitySelection.tsx";
import { QuickSetup, type QuickSetupChoice } from "./QuickSetup.tsx";

export interface SetupShellProps {
  readonly mode: SetupMode;
  readonly initialStep: "city" | "quick";
  readonly preselectedCityId: string | null;
  readonly cities: readonly CityConfig[];
  readonly downloadedSizes: ReadonlyMap<string, number>;
  readonly installedCityIds: ReadonlySet<string>;
  readonly offline: boolean;
  readonly catalogStatus: CatalogStatus;
  readonly storageAvailable: boolean;
  /** Path and query the user opened, when it is not the home screen. */
  readonly deepLink: string | null;
  readonly onDone: () => void;
}

type Step = "city" | "quick";

/** Setup progress kept in the history entry, so Back returns to the city
 * list and a reload resumes where the user was. It never activates anything. */
interface HistorySetupState {
  readonly step?: Step;
  readonly startMode?: StartMode;
}

const HISTORY_KEY = "ptnSetup";

function readHistoryState(): HistorySetupState {
  try {
    const value = (history.state as Record<string, unknown> | null)?.[HISTORY_KEY];
    return value && typeof value === "object" ? (value as HistorySetupState) : {};
  } catch {
    return {};
  }
}

function writeHistoryState(next: HistorySetupState, push = false): void {
  try {
    const state = { ...(history.state as object | null), [HISTORY_KEY]: next };
    if (push) history.pushState(state, "");
    else history.replaceState(state, "");
  } catch {
    // History is a convenience here; setup works without it.
  }
}

export function SetupShell(props: SetupShellProps) {
  const text = useSetupText();
  const { formattingLocale } = useTranslation();
  const restored = useMemo(readHistoryState, []);
  const [city, setCity] = useState<CityConfig | null>(
    () => props.cities.find((c) => c.id === props.preselectedCityId) ?? null,
  );
  const [step, setStep] = useState<Step>(() =>
    props.mode === "full" && city && (restored.step ?? props.initialStep) === "quick"
      ? "quick"
      : "city",
  );
  const [startMode, setStartMode] = useState<StartMode>(restored.startMode ?? "map");
  const [busyCityId, setBusyCityId] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availabilityVersion, setAvailabilityVersion] = useState(0);
  const pushedQuickStep = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(
    () => subscribeRealtimeAvailability(() => setAvailabilityVersion((v) => v + 1)),
    [],
  );

  // Browser Back from the second step returns to the city list.
  useEffect(() => {
    const onPop = () => {
      const state = readHistoryState();
      setStep(state.step === "quick" && city ? "quick" : "city");
      pushedQuickStep.current = state.step === "quick";
    };
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, [city]);

  // Move focus to the new step's heading; never on first render.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [step]);

  const formatSize = useCallback(
    (bytes: number) => {
      try {
        return new Intl.NumberFormat(formattingLocale, {
          style: "unit",
          unit: "megabyte",
          maximumFractionDigits: 0,
        }).format(Math.max(1, Math.round(bytes / 1_000_000)));
      } catch {
        return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
      }
    },
    [formattingLocale],
  );

  const selectCity = async (next: CityConfig) => {
    setBusyCityId(next.id);
    try {
      await chooseSetupCity(next, { offline: props.offline });
    } finally {
      setBusyCityId(null);
    }
    setCity(next);
    if (props.mode === "city-only") {
      props.onDone();
      return;
    }
    writeHistoryState({ step: "quick", startMode }, true);
    pushedQuickStep.current = true;
    setStep("quick");
  };

  const changeCity = () => {
    if (pushedQuickStep.current) {
      history.back();
      return;
    }
    writeHistoryState({ step: "city", startMode });
    setStep("city");
  };

  const changeStartMode = (mode: StartMode) => {
    setStartMode(mode);
    writeHistoryState({ ...readHistoryState(), startMode: mode });
  };

  const choose = async (choice: QuickSetupChoice) => {
    setCommitting(true);
    setError(null);
    try {
      await completeSetup({ ...choice, startMode });
    } catch {
      setCommitting(false);
      setError(text("setup.saveFailed"));
      return;
    }
    // Setup progress no longer applies to this history entry.
    try {
      const rest = { ...(history.state as Record<string, unknown> | null) };
      delete rest[HISTORY_KEY];
      history.replaceState(rest, "");
    } catch {
      // Ignore.
    }
    props.onDone();
  };

  const realtimeKinds = useMemo(
    () => (city ? getRealtimeAvailability(city.id) : undefined),
    // Re-read when stored availability changes (manifest response, other tab).
    [city, availabilityVersion],
  );

  return (
    <main
      ref={mainRef}
      data-testid="setup-shell"
      className="min-h-dvh bg-surface px-4 py-6 text-fg [&_h1]:outline-none"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        {!props.storageAvailable && (
          <p role="status" className="rounded-lg border border-divider bg-surface-raised p-3 text-sm">
            {text("setup.storageUnavailable")}
          </p>
        )}
        {props.deepLink && (
          <p className="rounded-lg border border-divider bg-surface-raised p-3 text-sm">
            {text(step === "city" ? "setup.deepLink" : "setup.deepLinkQuick")}
          </p>
        )}
        {step === "quick" && city ? (
          <QuickSetup
            cityName={city.name}
            realtimeKinds={realtimeKinds}
            startMode={startMode}
            onStartModeChange={changeStartMode}
            onChoose={(choice) => void choose(choice)}
            onChangeCity={changeCity}
            busy={committing}
            error={error}
            text={text}
          />
        ) : (
          <CitySelection
            cities={props.cities}
            downloadedSizes={props.downloadedSizes}
            installedCityIds={props.installedCityIds}
            offline={props.offline}
            catalogStatus={props.catalogStatus}
            preselectedCityId={city?.id ?? props.preselectedCityId}
            busyCityId={busyCityId}
            text={text}
            formatSize={formatSize}
            onSelect={(next) => void selectCity(next)}
            onRetry={() => globalThis.location.reload()}
          />
        )}
        <LanguagePicker />
      </div>
    </main>
  );
}
