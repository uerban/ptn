import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown } from "../../src/hooks/useCountdown.ts";

describe("useCountdown", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns minutes until departure", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { result } = renderHook(() => useCountdown([future]));
    expect(result.current[0]).toBe(5);
  });

  it("returns negative minutes for departed", () => {
    const past = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { result } = renderHook(() => useCountdown([past]));
    expect(result.current[0]).toBe(-3);
  });

  it("updates every second", () => {
    const future = new Date(Date.now() + 90 * 1000).toISOString(); // 1.5 min
    const { result } = renderHook(() => useCountdown([future]));
    expect(result.current[0]).toBe(2); // rounds up via Math.ceil
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current[0]).toBe(1);
  });
});
