import { afterEach } from "vitest";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MobilityProfile } from "@pt/shared";
import { useSettingsStore, type RouteSearchVariant } from "../../src/stores/settingsStore.ts";
import { effectiveVariant } from "../../src/utils/appearance.ts";

interface Options extends Omit<RenderOptions, "wrapper"> {
  variant?: RouteSearchVariant;
  mobility?: MobilityProfile;
}

/**
 * Render a UI tree with `routeSearchVariant` and `mobilityProfile` preset on the
 * settings store. Also sets the `data-variant` attribute on <html> so CSS-var
 * consumers see the correct tokens.
 *
 * Phase 2 reuses this helper for ReroutePrompt + TransferMonitor tests.
 */
export function renderWithVariant(ui: ReactNode, opts: Options = {}): RenderResult {
  const { variant = "consumer", mobility = "default", ...rest } = opts;
  useSettingsStore.setState({ routeSearchVariant: variant, mobilityProfile: mobility });
  const effective = effectiveVariant(variant, mobility);
  document.documentElement.setAttribute("data-variant", effective);
  return render(<>{ui}</>, rest);
}

// Teardown: reset the attribute + store so nothing leaks between tests.
afterEach(() => {
  document.documentElement.removeAttribute("data-variant");
  useSettingsStore.setState({ routeSearchVariant: "consumer", mobilityProfile: "default" });
});
