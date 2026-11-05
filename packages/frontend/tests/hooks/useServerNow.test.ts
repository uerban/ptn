import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServerNow } from "../../src/hooks/useServerNow.ts";

describe("useServerNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the current server time", () => {
    const { result } = renderHook(() => useServerNow(10_000));
    expect(result.current).toBe(Date.parse("2026-09-25T20:00:00Z"));
  });

  it("moves on every interval", () => {
    const { result } = renderHook(() => useServerNow(10_000));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(Date.parse("2026-09-25T20:00:10Z"));
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(result.current).toBe(Date.parse("2026-09-25T20:00:30Z"));
  });

  it("stays still while paused", () => {
    const { result } = renderHook(() => useServerNow(10_000, false));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(Date.parse("2026-09-25T20:00:00Z"));
  });
});
