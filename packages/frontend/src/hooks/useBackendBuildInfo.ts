import { useEffect, useState } from "react";
import type { BuildInfo } from "@pt/shared";
import { useCityStore } from "../stores/cityStore.ts";

export type BackendBuildInfoState =
  | { status: "loading"; data: null }
  | { status: "ok"; data: BuildInfo }
  | { status: "error"; data: null };

const FETCH_TIMEOUT_MS = 3000;

function isBuildInfo(v: unknown): v is BuildInfo {
  if (!v || typeof v !== "object") return false;
  const { version, commit, builtAt } = v as Record<string, unknown>;
  return typeof version === "string" && typeof commit === "string" && typeof builtAt === "string";
}

export function useBackendBuildInfo(): BackendBuildInfoState {
  const [state, setState] = useState<BackendBuildInfoState>({ status: "loading", data: null });

  useEffect(() => {
    const controller = new AbortController();
    let unmounted = false;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const apiUrl = useCityStore.getState().getApiUrl();
        const res = await fetch(`${apiUrl}/version`, { signal: controller.signal });
        if (unmounted) return;
        if (!res.ok) {
          console.warn(`[useBackendBuildInfo] /version returned HTTP ${res.status}`);
          setState({ status: "error", data: null });
          return;
        }
        const body: unknown = await res.json();
        if (unmounted) return;
        if (!isBuildInfo(body)) {
          console.warn("[useBackendBuildInfo] /version returned unexpected shape:", body);
          setState({ status: "error", data: null });
          return;
        }
        setState({ status: "ok", data: body });
      } catch (err) {
        if (unmounted) return;
        // Timeout-driven abort still transitions to "error" so a slow backend
        // doesn't leave the hook stuck in "loading" forever.
        if (err instanceof DOMException && err.name === "AbortError") {
          setState({ status: "error", data: null });
          return;
        }
        console.warn("[useBackendBuildInfo] /version fetch failed:", err);
        setState({ status: "error", data: null });
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      unmounted = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  return state;
}
