import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { PoiLoadError, PoiLoadStatusListener } from "../../services/poiLoader.ts";

const mocks = vi.hoisted(() => {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const poiListeners = new Set<PoiLoadStatusListener>();
  return {
    emitter: {
      subscribe(listener: (event: Record<string, unknown>) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      emit(event: Record<string, unknown>) {
        for (const l of listeners) l(event);
      },
      clear() {
        listeners.clear();
      },
    },
    poiStatus: {
      subscribe(listener: PoiLoadStatusListener) {
        poiListeners.add(listener);
        return () => {
          poiListeners.delete(listener);
        };
      },
      emit(errors: ReadonlyMap<string, PoiLoadError>) {
        for (const l of poiListeners) l(errors);
      },
      clear() {
        poiListeners.clear();
      },
    },
  };
});

vi.mock("../../services/geocoder/instance.ts", () => ({
  geocoderRegistry: { status: mocks.emitter },
}));

vi.mock("../../services/poiLoader.ts", () => ({
  onPoiLoadStatusChange: (listener: PoiLoadStatusListener) =>
    mocks.poiStatus.subscribe(listener),
  getPoiLoadErrors: () => new Map(),
  poiCityIds: (frontendCityId: string) =>
    frontendCityId === "tricity"
      ? ["gdansk", "gdynia", "sopot"]
      : [frontendCityId],
}));

vi.mock("../../stores/cityStore.ts", () => {
  const state = { activeCity: { id: "tricity" } };
  return {
    useCityStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => selector ? selector(state) : state,
      { getState: () => state },
    ),
  };
});

import { GeocoderStatusChip } from "./GeocoderStatusChip.tsx";

beforeEach(() => {
  mocks.emitter.clear();
  mocks.poiStatus.clear();
});

afterEach(() => {
  cleanup();
});

describe("GeocoderStatusChip", () => {
  test("renders nothing when no provider-failed event has fired", () => {
    const { container } = render(<GeocoderStatusChip />);
    expect(container.innerHTML).toBe("");
  });

  test("shows chip when self-hosted provider emits provider-failed", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      mocks.emitter.emit({
        kind: "provider-failed",
        provider: "self-hosted",
        error: "fetch failed",
      });
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain(
      "Self-hosted geocoder unreachable",
    );
    expect(alert.textContent).toContain("on-device search only");
  });

  test("does not show chip for non-self-hosted provider failures", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      mocks.emitter.emit({
        kind: "provider-failed",
        provider: "bundled",
        error: "boom",
      });
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("does not show chip for provider-degraded events", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      mocks.emitter.emit({
        kind: "provider-degraded",
        provider: "self-hosted",
        reason: "slow",
      });
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("uses i18n key geocoder.fallback.selfHostedUnreachable", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      mocks.emitter.emit({
        kind: "provider-failed",
        provider: "self-hosted",
        error: "timeout",
      });
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "Self-hosted geocoder unreachable \u2014 using on-device search only.",
    );
  });

  test("cleans up subscription on unmount", () => {
    const { unmount } = render(<GeocoderStatusChip />);
    unmount();

    act(() => {
      mocks.emitter.emit({
        kind: "provider-failed",
        provider: "self-hosted",
        error: "after unmount",
      });
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows total failure message when all cities fail", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:strict", { kind: "fetch", cityId: "gdansk", tier: "strict", message: "error", timestamp: Date.now() }],
        ["gdynia:strict", { kind: "fetch", cityId: "gdynia", tier: "strict", message: "error", timestamp: Date.now() }],
        ["sopot:strict", { kind: "fetch", cityId: "sopot", tier: "strict", message: "error", timestamp: Date.now() }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("POI data unavailable");
    expect(alert.textContent).toContain("stop search only");
  });

  test("shows partial failure message when only some cities fail", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:strict", { kind: "fetch", cityId: "gdansk", tier: "strict", message: "Network error", timestamp: Date.now() }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Some POI data unavailable");
    expect(alert.textContent).toContain("may be incomplete");
  });

  test("shows partial quota message when one city hits quota", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        [
          "gdansk:strict",
          {
            kind: "quota",
            cityId: "gdansk",
            tier: "strict",
            message: "Storage full",
            timestamp: Date.now(),
          },
        ],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Storage full");
    expect(alert.textContent).toContain("some POI data may be incomplete");
  });

  test("shows full quota message when all cities hit quota", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:strict", { kind: "quota", cityId: "gdansk", tier: "strict", message: "Storage full", timestamp: Date.now() }],
        ["gdynia:strict", { kind: "quota", cityId: "gdynia", tier: "strict", message: "Storage full", timestamp: Date.now() }],
        ["sopot:strict", { kind: "quota", cityId: "sopot", tier: "strict", message: "Storage full", timestamp: Date.now() }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Storage full");
    expect(alert.textContent).toContain("POI search unavailable");
  });

  test("prioritizes quota error over fetch errors in mixed failures", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:strict", { kind: "fetch", cityId: "gdansk", tier: "strict", message: "Network error", timestamp: Date.now() }],
        ["gdynia:strict", { kind: "quota", cityId: "gdynia", tier: "strict", message: "Storage full", timestamp: Date.now() }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Storage full");
    expect(alert.textContent).toContain("some POI data may be incomplete");
  });

  test("ignores loose-tier errors (loose is supplementary)", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        [
          "gdansk:loose",
          {
            kind: "fetch",
            cityId: "gdansk",
            tier: "loose",
            message: "Network error",
            timestamp: Date.now(),
          },
        ],
      ]);
      mocks.poiStatus.emit(errors);
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("ignores strict errors from non-active cities", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        [
          "vilnius:strict",
          {
            kind: "fetch",
            cityId: "vilnius",
            tier: "strict",
            message: "Vilnius failed",
            timestamp: Date.now(),
          },
        ],
      ]);
      mocks.poiStatus.emit(errors);
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows strict error even when loose error also present", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:loose", { kind: "fetch", cityId: "gdansk", tier: "loose", message: "Loose failed", timestamp: Date.now() }],
        ["gdansk:strict", { kind: "fetch", cityId: "gdansk", tier: "strict", message: "Strict failed", timestamp: Date.now() }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Some POI data unavailable");
  });

  test("suppresses error banner when all failing cities have cached data", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:strict", { kind: "fetch", cityId: "gdansk", tier: "strict", message: "error", timestamp: Date.now(), hasCachedFallback: true }],
        ["gdynia:strict", { kind: "fetch", cityId: "gdynia", tier: "strict", message: "error", timestamp: Date.now(), hasCachedFallback: true }],
        ["sopot:strict", { kind: "fetch", cityId: "sopot", tier: "strict", message: "error", timestamp: Date.now(), hasCachedFallback: true }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows error for cities without cached data even when others have cache", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        ["gdansk:strict", { kind: "fetch", cityId: "gdansk", tier: "strict", message: "error", timestamp: Date.now(), hasCachedFallback: true }],
        ["gdynia:strict", { kind: "fetch", cityId: "gdynia", tier: "strict", message: "error", timestamp: Date.now() }],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Some POI data unavailable");
  });

  test("clears POI error chip when errors resolve", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      const errors = new Map<string, PoiLoadError>([
        [
          "gdansk:strict",
          {
            kind: "fetch",
            cityId: "gdansk",
            tier: "strict",
            message: "error",
            timestamp: Date.now(),
          },
        ],
      ]);
      mocks.poiStatus.emit(errors);
    });

    expect(screen.getByRole("alert")).toBeDefined();

    act(() => {
      mocks.poiStatus.emit(new Map());
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows both geocoder and POI errors simultaneously", () => {
    render(<GeocoderStatusChip />);

    act(() => {
      mocks.emitter.emit({
        kind: "provider-failed",
        provider: "self-hosted",
        error: "timeout",
      });
      const errors = new Map<string, PoiLoadError>([
        [
          "gdansk:strict",
          {
            kind: "fetch",
            cityId: "gdansk",
            tier: "strict",
            message: "error",
            timestamp: Date.now(),
          },
        ],
      ]);
      mocks.poiStatus.emit(errors);
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
  });

  test("clears the self-hosted chip on provider-recovered", () => {
    render(<GeocoderStatusChip />);
    act(() => {
      mocks.emitter.emit({ kind: "provider-failed", provider: "self-hosted", error: "boom" });
    });
    expect(screen.getByRole("alert")).toBeDefined();
    act(() => {
      mocks.emitter.emit({ kind: "provider-recovered", provider: "self-hosted" });
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("provider-recovered for a NON-self-hosted provider does not clear the self-hosted chip", () => {
    render(<GeocoderStatusChip />);
    act(() => {
      mocks.emitter.emit({ kind: "provider-failed", provider: "self-hosted", error: "boom" });
    });
    act(() => {
      mocks.emitter.emit({ kind: "provider-recovered", provider: "bundled" });
    });
    expect(screen.getByRole("alert")).toBeDefined();
  });

  test("provider-degraded does NOT clear the self-hosted chip (recovery reacts to provider-recovered only)", () => {
    render(<GeocoderStatusChip />);
    act(() => {
      mocks.emitter.emit({ kind: "provider-failed", provider: "self-hosted", error: "boom" });
    });
    act(() => {
      mocks.emitter.emit({ kind: "provider-degraded", provider: "self-hosted", reason: "slow" });
    });
    expect(screen.getByRole("alert")).toBeDefined();
  });
});
