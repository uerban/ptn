import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useBackendBuildInfo } from "./useBackendBuildInfo.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useBackendBuildInfo", () => {
  it("returns ok with the parsed body on 200", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ version: "0.1.246", commit: "cafef00d", builtAt: "2026-05-04T18:18:02Z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBackendBuildInfo());

    await waitFor(() => {
      expect(result.current.status).toBe("ok");
    });
    expect(result.current.data).toEqual({
      version: "0.1.246",
      commit: "cafef00d",
      builtAt: "2026-05-04T18:18:02Z",
    });
  });

  it("returns error / null data on a network failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBackendBuildInfo());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.data).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns error on non-200 responses (e.g. older backend without /api/version)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    const { result } = renderHook(() => useBackendBuildInfo());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.data).toBeNull();
  });

  it("calls /api/<city>/version, not the unprefixed /api/version", async () => {
    let calledUrl: string | undefined;
    globalThis.fetch = vi.fn(async (url) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({ version: "0.1.0", commit: "x", builtAt: "z" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    renderHook(() => useBackendBuildInfo());

    await waitFor(() => expect(calledUrl).toBeDefined());
    expect(calledUrl).toMatch(/^\/api\/[^/]+\/version$/);
  });

  it("aborts the in-flight fetch on unmount", async () => {
    let abortSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      abortSignal = init?.signal ?? undefined;
      // Hang forever — only resolves if aborted.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const { unmount } = renderHook(() => useBackendBuildInfo());
    unmount();

    expect(abortSignal?.aborted).toBe(true);
  });

  it("returns error when response body does not match BuildInfo shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () =>
      new Response("<html><body>SPA fallback</body></html>", { status: 200 }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBackendBuildInfo());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.data).toBeNull();
  });

  it("transitions to error after 3s timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBackendBuildInfo());

    expect(result.current.status).toBe("loading");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      // Flush microtasks so the promise rejection and setState land
      await Promise.resolve();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.data).toBeNull();
  });
});
