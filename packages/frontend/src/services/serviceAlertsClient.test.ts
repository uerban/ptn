import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ServiceAlertsResponse } from "@pt/shared";
import golden from "../../../shared/src/types/__fixtures__/service-alerts-response.json";
import {
  NETWORK_DECISIONS_STORAGE_KEY,
  useNetworkDecisionsStore,
} from "../stores/networkDecisionsStore.ts";
import { recordRealtimeHeader } from "./realtimeAvailability.ts";
import {
  __resetServiceAlertsForTests,
  getServiceAlertsSnapshot,
  parseServiceAlertsResponse,
  SERVICE_ALERTS_POLL_MS,
  SERVICE_ALERTS_RETRY_MS,
  subscribeServiceAlerts,
  useServiceAlerts,
} from "./serviceAlertsClient.ts";

const CITY = "vilnius";

function body(overrides: Partial<ServiceAlertsResponse> = {}): ServiceAlertsResponse {
  return {
    schemaVersion: 1,
    city: CITY,
    fetchedAt: "2026-11-07T10:00:00Z",
    stale: false,
    alerts: [
      {
        id: "a1",
        cause: "CONSTRUCTION",
        effect: "DETOUR",
        severity: "WARNING",
        header: [{ text: "Detour" }],
        description: [],
        url: [],
        activePeriods: [],
        informedEntities: [{ routeId: "R1" }],
      },
    ],
    ...overrides,
  };
}

function ok(payload: unknown, etag = '"v1"'): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ETag: etag, "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState = "visible";

function allow(): void {
  useNetworkDecisionsStore
    .getState()
    .setDecision("operator.service-alerts", "allowed", "settings");
}

function revoke(): void {
  useNetworkDecisionsStore
    .getState()
    .setDecision("operator.service-alerts", "denied", "settings");
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok(body())));
  __resetServiceAlertsForTests({ fetch: fetchMock as unknown as typeof fetch });
});

afterEach(() => {
  __resetServiceAlertsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("serviceAlertsClient gating", () => {
  it("makes no request while the flow is undecided", async () => {
    recordRealtimeHeader(CITY, "alerts");
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getServiceAlertsSnapshot(CITY).status).toBe("blocked");
    stop();
  });

  it("makes no request where the city does not list alerts, or is unknown", async () => {
    allow();
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(getServiceAlertsSnapshot(CITY).status).toBe("unavailable");
    recordRealtimeHeader(CITY, "departures");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getServiceAlertsSnapshot(CITY).status).toBe("unavailable");
    stop();
  });

  it("makes no request without a visible surface", async () => {
    allow();
    recordRealtimeHeader(CITY, "alerts");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches city-wide once allowed and available", async () => {
    allow();
    recordRealtimeHeader(CITY, "alerts");
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/vilnius/alerts");
    expect((init.headers as Headers).has("If-None-Match")).toBe(false);
    // Nothing about the page on screen travels with it.
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.credentials).toBe("omit");
    const snapshot = getServiceAlertsSnapshot(CITY);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.response?.alerts.map((a) => a.id)).toEqual(["a1"]);
    stop();
  });

  it("starts as soon as availability or the decision arrives", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    recordRealtimeHeader(CITY, "alerts");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    allow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("serviceAlertsClient polling", () => {
  beforeEach(() => {
    allow();
    recordRealtimeHeader(CITY, "alerts");
  });

  it("revalidates with If-None-Match every poll interval and keeps the answer on 304", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    const first = getServiceAlertsSnapshot(CITY).response;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((init.headers as Headers).get("If-None-Match")).toBe('"v1"');
    expect(getServiceAlertsSnapshot(CITY).response).toBe(first);
    expect(getServiceAlertsSnapshot(CITY).checkedAt).toBe(Date.now());
    stop();
  });

  it("pauses while the document is hidden and resumes when due", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops polling when the last surface goes away", async () => {
    const stopA = subscribeServiceAlerts(CITY, () => {});
    const stopB = subscribeServiceAlerts(CITY, () => {});
    await flush();
    stopA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stopB();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when a surface reopens within the interval", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    stop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const again = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS - 10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    again();
  });

  it("reports failures, keeps the last answer and retries sooner", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS);
    });
    const failed = getServiceAlertsSnapshot(CITY);
    expect(failed.status).toBe("failed");
    expect(failed.response?.alerts).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_RETRY_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
  });

  it("fails on a server that has not fetched yet and on foreign bodies", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(getServiceAlertsSnapshot(CITY).status).toBe("failed");
    fetchMock.mockImplementation(() => Promise.resolve(ok(body({ city: "riga" }))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_RETRY_MS);
    });
    expect(getServiceAlertsSnapshot(CITY).status).toBe("failed");
    expect(getServiceAlertsSnapshot(CITY).response).toBeUndefined();
    stop();
  });

  it("asks again without If-None-Match when a 304 arrives with nothing held", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 304 })))
      .mockImplementation(() => Promise.resolve(ok(body())));
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((retry.headers as Headers).has("If-None-Match")).toBe(false);
    expect(getServiceAlertsSnapshot(CITY)).toMatchObject({ status: "ready" });
    expect(getServiceAlertsSnapshot(CITY).response?.alerts).toHaveLength(1);
    stop();
  });
});

describe("serviceAlertsClient revocation", () => {
  beforeEach(() => {
    allow();
    recordRealtimeHeader(CITY, "alerts");
  });

  it("drops alerts and stops polling when the decision is revoked", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(getServiceAlertsSnapshot(CITY).response).toBeDefined();
    revoke();
    const snapshot = getServiceAlertsSnapshot(CITY);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.response).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("aborts an in-flight request and ignores its late answer", async () => {
    let resolveFetch: (res: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    revoke();
    expect(signal?.aborted).toBe(true);
    resolveFetch(ok(body()));
    await flush();
    expect(getServiceAlertsSnapshot(CITY).response).toBeUndefined();
    stop();
  });

  it("rechecks the decision before applying a response", async () => {
    let resolveFetch: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    // Change the stored decision without notifying subscribers, as a late
    // rehydration would before its listeners run.
    useNetworkDecisionsStore.setState({ decisions: {} }, false);
    resolveFetch(ok(body()));
    await flush();
    expect(getServiceAlertsSnapshot(CITY).response).toBeUndefined();
    stop();
  });

  it("stops when another tab revokes the decision", async () => {
    const { installPrivacyStateSync } = await import("../stores/onboardingStore.ts");
    const uninstall = installPrivacyStateSync();
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    localStorage.setItem(
      NETWORK_DECISIONS_STORAGE_KEY,
      JSON.stringify({
        state: {
          decisions: {
            "operator.service-alerts": { value: "denied", source: "settings", decidedAt: Date.now() + 1 },
          },
        },
        version: 1,
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: NETWORK_DECISIONS_STORAGE_KEY }),
    );
    await flush();
    expect(getServiceAlertsSnapshot(CITY).status).toBe("blocked");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_ALERTS_POLL_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    uninstall();
  });

  it("drops alerts when the city stops listing them", async () => {
    const stop = subscribeServiceAlerts(CITY, () => {});
    await flush();
    recordRealtimeHeader(CITY, "departures");
    expect(getServiceAlertsSnapshot(CITY).status).toBe("unavailable");
    expect(getServiceAlertsSnapshot(CITY).response).toBeUndefined();
    stop();
  });
});

describe("useServiceAlerts", () => {
  it("subscribes only while visible and re-renders with new answers", async () => {
    allow();
    recordRealtimeHeader(CITY, "alerts");
    const { result, rerender } = renderHook(
      ({ visible }) => useServiceAlerts(CITY, visible),
      { initialProps: { visible: false } },
    );
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ visible: true });
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.response?.alerts).toHaveLength(1);
  });
});

describe("parseServiceAlertsResponse", () => {
  it("accepts only the known schema version for the requested city", () => {
    expect(parseServiceAlertsResponse(body(), CITY)).toBeDefined();
    expect(parseServiceAlertsResponse({ ...body(), schemaVersion: 2 }, CITY)).toBeUndefined();
    expect(parseServiceAlertsResponse(body(), "riga")).toBeUndefined();
    expect(parseServiceAlertsResponse(null, CITY)).toBeUndefined();
  });

  it("drops malformed alerts individually", () => {
    const parsed = parseServiceAlertsResponse(
      { ...body(), alerts: [...body().alerts, { id: 3 }, null] },
      CITY,
    );
    expect(parsed?.alerts.map((a) => a.id)).toEqual(["a1"]);
  });

  it("reads a severity it does not know as unknown", () => {
    const [alert] = body().alerts;
    const parsed = parseServiceAlertsResponse(
      { ...body(), alerts: [{ ...alert, severity: "CATASTROPHIC" }] },
      CITY,
    );
    expect(parsed?.alerts[0]?.severity).toBe("UNKNOWN");
  });

  it("keeps every alert of the reply the server's tests produce", () => {
    const parsed = parseServiceAlertsResponse(golden, "vilnius");
    expect(parsed).toEqual(golden);
  });
});
