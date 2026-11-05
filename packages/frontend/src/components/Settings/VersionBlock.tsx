import { useState, useRef, useEffect } from "react";
import { buildInfo } from "../../buildInfo.ts";
import { useBackendBuildInfo } from "../../hooks/useBackendBuildInfo.ts";
import { useTranslation } from "../../i18n/index.ts";

const COPIED_RESET_MS = 2000;

function buildCopyText(
  frontend: typeof buildInfo,
  backend: typeof buildInfo | null,
): string {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const backendLine = backend
    ? `Backend:  v${backend.version} (${backend.commit}) built ${backend.builtAt}`
    : "Backend: unavailable";
  return [
    `Frontend: v${frontend.version} (${frontend.commit}) built ${frontend.builtAt}`,
    backendLine,
    `UA: ${userAgent}`,
  ].join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("[VersionBlock] navigator.clipboard.writeText failed:", err);
    /* fall through */
  }
  // Legacy fallback for insecure contexts / older WebViews.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.warn("[VersionBlock] execCommand copy failed:", err);
    return false;
  }
}

function commitClass(commit: string): string {
  return commit.endsWith("-dirty") ? "text-fg-muted italic" : "";
}

// "YYYY-MM-DD HH:MM UTC" — locale-free, comparable across devices.
// Especially load-bearing when commit is "unknown" (Portainer-built image
// without .git/ in context); the timestamp is then the only signal of
// which build the device is actually running.
function formatBuiltAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export interface VersionBlockProps {
  /**
   * Fired on every click, alongside the copy-to-clipboard action. The About
   * section hangs its click-count easter egg off this so the version block is
   * the single interactive target in that card.
   */
  onClick?: () => void;
}

export function VersionBlock({ onClick }: VersionBlockProps = {}) {
  const { t } = useTranslation();
  const backend = useBackendBuildInfo();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const handleClick = async () => {
    onClick?.();
    const ok = await copyToClipboard(buildCopyText(buildInfo, backend.data));
    setStatus(ok ? "copied" : "failed");
    if (ok) {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = setTimeout(() => {
        setStatus("idle");
        copiedTimerRef.current = null;
      }, COPIED_RESET_MS);
    }
  };

  const trailingText = (() => {
    if (status === "copied") return t("settings.version_copied", "Copied to clipboard ✓");
    if (status === "failed") return t("settings.version_copy_failed", "Copy failed");
    return `AGPL-3.0 · ${t("settings.about_meta", "No tracking, no ads")}`;
  })();

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left text-sm text-fg-secondary hover:bg-surface-overlay rounded-lg p-2 -mx-2 mt-2 transition-colors"
    >
      <div data-testid="version-frontend" className="flex justify-between gap-2">
        <span>Frontend</span>
        <span className="font-mono text-right">
          v{buildInfo.version} ·{" "}
          <span className={commitClass(buildInfo.commit)}>{buildInfo.commit}</span>
          <span className="block text-[11px] text-fg-muted">
            {formatBuiltAt(buildInfo.builtAt)}
          </span>
        </span>
      </div>
      <div data-testid="version-backend" className="flex justify-between gap-2">
        <span>Backend</span>
        <span className="font-mono text-right">
          {backend.data ? (
            <>
              v{backend.data.version} ·{" "}
              <span className={commitClass(backend.data.commit)}>{backend.data.commit}</span>
              <span className="block text-[11px] text-fg-muted">
                {formatBuiltAt(backend.data.builtAt)}
              </span>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
      <p
        className="text-xs text-fg-muted mt-2"
        aria-live="polite"
      >
        {trailingText}
      </p>
    </button>
  );
}
