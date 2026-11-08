import { useState } from "react";
import { SearchPickerLayoutContext, usePickerViewport } from "../Search/SearchPickerLayout.ts";
import { Outlet, NavLink } from "react-router-dom";
import { useConnectivity } from "../../hooks/useConnectivity.ts";
import { useTranslation } from "../../i18n/index.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { IOSInstallPrompt } from "./IOSInstallPrompt.tsx";
import { BackendStatus } from "./BackendStatus.tsx";
import { GeocoderStatusChip } from "./GeocoderStatusChip.tsx";
import { PersonalStorageNotice } from "../Privacy/PersonalStorageNotice.tsx";
import { Icon } from "../Icon.tsx";
import { usePresentationText } from "../../i18n/presentationStrings.ts";

export function Layout() {
  const [fitSearchPicker, setFitSearchPicker] = useState(false);
  const pickerStyle = usePickerViewport(fitSearchPicker);
  const isOnline = useConnectivity();
  const { t } = useTranslation();
  const scheduleMode = useSettingsStore((s) => s.scheduleMode);
  const presentationText = usePresentationText();

  return (
    <SearchPickerLayoutContext.Provider value={setFitSearchPicker}>
    <div className="flex flex-col h-full pt-safe" style={pickerStyle}>
      <a
        href="#main-content"
        data-testid="skip-link"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:p-2 focus:bg-bg focus:text-fg focus:ring-2 focus:ring-accent focus:rounded"
      >
        {t("a11y.skip_to_content", "Skip to main content")}
      </a>
      {!fitSearchPicker && <IOSInstallPrompt />}
      {!isOnline && (
        <div className="bg-warning text-warning-fg text-center text-sm py-1 px-3">
          {t("offline.banner", "Offline — showing cached data")}
        </div>
      )}
      {isOnline && <BackendStatus />}
      <GeocoderStatusChip />
      {!fitSearchPicker && <PersonalStorageNotice />}

      <main id="main-content" tabIndex={-1} className="flex-1 overflow-hidden relative">
        <Outlet />
      </main>

      {!fitSearchPicker && <nav className="flex border-t border-divider bg-nav-bg shrink-0 pb-safe">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center py-2 text-xs ${
              isActive
                ? "text-nav-fg-active"
                : "text-nav-fg"
            }`
          }
        >
          <Icon name={scheduleMode ? "clock" : "map"} size={24} />
          <span>{scheduleMode ? presentationText("presentation.navText") : t("nav.map", "Map")}</span>
        </NavLink>
        <NavLink
          to="/search"
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center py-2 text-xs ${
              isActive
                ? "text-nav-fg-active"
                : "text-nav-fg"
            }`
          }
        >
          <Icon name="search" size={24} />
          <span>{t("nav.search", "Search")}</span>
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center py-2 text-xs ${
              isActive
                ? "text-nav-fg-active"
                : "text-nav-fg"
            }`
          }
        >
          <Icon name="settings" size={24} />
          <span>{t("nav.settings", "Settings")}</span>
        </NavLink>
      </nav>}
    </div>
    </SearchPickerLayoutContext.Provider>
  );
}
