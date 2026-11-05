import { getPolicy } from "../../stores/privacyStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import type { ThirdPartyProviderId } from "../../config/geocoderProviders.ts";
import {
  ThirdPartyGeocoderAdapter,
  configFromAllowlist,
} from "./ThirdPartyGeocoderAdapter.ts";
import { geocoderRegistry } from "./instance.ts";

const registered = new Set<string>();

export function registerThirdPartyGeocoder(
  providerId: ThirdPartyProviderId,
): void {
  if (registered.has(providerId)) return;
  registered.add(providerId);
  geocoderRegistry.register(
    new ThirdPartyGeocoderAdapter(
      configFromAllowlist(providerId),
      () => ({
        m10ThirdPartyEnabled: getPolicy().m10ThirdPartyEnabled,
        m10CoarsenGridDefaultMeters: getPolicy().m10CoarsenGridDefaultMeters,
      }),
      () => useSettingsStore.getState().thirdPartyApiKeys[providerId],
    ),
  );
}
