import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useServerTimeSync } from "./useServerTimeSync.ts";
import { serverTime } from "../services/serverTime.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useServerTimeSync", () => {
  it("syncs serverTime from the response Date header on success", async () => {
    const dateHeader = "Mon, 11 May 2026 12:34:56 GMT";
    const updateSpy = vi.spyOn(serverTime, "update").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ version: "0.1.0", commit: "x", builtAt: "z" }),
        {
          status: 200,
          headers: { "content-type": "application/json", Date: dateHeader },
        },
      ),
    ) as unknown as typeof fetch;

    renderHook(() => useServerTimeSync());

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(dateHeader);
    });
  });

  it("warns and does not call serverTime.update when Date header is absent", async () => {
    // A missing Date header from /version means an intermediary stripped it
    // — visible only via this warn until someone notices `serverTime.now()`
    // matches client time for the whole session.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const updateSpy = vi.spyOn(serverTime, "update").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ version: "0.1.0", commit: "x", builtAt: "z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    renderHook(() => useServerTimeSync());

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/no Date header/i);
  });

  it("does not call serverTime.update on a non-200 response", async () => {
    const updateSpy = vi.spyOn(serverTime, "update").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 503 }),
    ) as unknown as typeof fetch;

    renderHook(() => useServerTimeSync());

    // Let microtasks flush; the hook should have processed the response
    // and skipped the update call.
    await act(async () => { await Promise.resolve(); });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not throw or call serverTime.update on a network failure", async () => {
    const updateSpy = vi.spyOn(serverTime, "update").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useServerTimeSync());
    await act(async () => { await Promise.resolve(); });

    expect(result.current).toBeUndefined();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("aborts the in-flight fetch on unmount", async () => {
    let abortSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      abortSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("abort", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;

    const { unmount } = renderHook(() => useServerTimeSync());
    unmount();

    expect(abortSignal?.aborted).toBe(true);
  });
});
