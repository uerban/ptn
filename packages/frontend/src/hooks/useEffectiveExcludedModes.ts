import { useMemo } from "react";
import { effectiveExcludedModes, useSettingsStore } from "../stores/settingsStore.ts";
import { useCityStore } from "../stores/cityStore.ts";

export function useEffectiveExcludedModes() {
  const excludedModes = useSettingsStore(state => state.excludedModes);
  const enabledModes = useSettingsStore(state => state.enabledModes);
  const defaults = useCityStore(state => state.activeCity.defaultExcludedModes);
  return useMemo(() => effectiveExcludedModes({excludedModes, enabledModes}, defaults), [excludedModes, enabledModes, defaults]);
}
