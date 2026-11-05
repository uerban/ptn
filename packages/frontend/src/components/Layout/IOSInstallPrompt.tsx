import { useState, useEffect } from "react";
import { useTranslation } from "../../i18n/index.ts";
import { Icon } from "../Icon.tsx";

const DISMISSED_KEY = "ptn-ios-install-dismissed";

function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);
  return isIOS && isSafari;
}

function isStandalone(): boolean {
  return (
    ("standalone" in navigator && (navigator as Record<string, unknown>).standalone === true) ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

export function IOSInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (isIOSSafari() && !isStandalone() && !localStorage.getItem(DISMISSED_KEY)) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  }

  return (
    <div className="flex items-center gap-3 bg-accent/10 px-4 py-2.5 text-sm text-accent">
      <p className="flex-1">
        {t("install.ios", "Install this app: tap")}{" "}
        <svg
          className="inline-block w-4 h-4 align-text-bottom"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>{" "}
        {t("install.ios_action", "then")} <strong>{t("install.ios_add", "Add to Home Screen")}</strong>
      </p>
      <button
        onClick={dismiss}
        className="shrink-0 p-1 rounded hover:bg-accent/20"
        aria-label="Dismiss"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
