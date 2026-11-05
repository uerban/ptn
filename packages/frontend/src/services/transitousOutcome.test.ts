import { describe, it, expect } from "vitest";
import { HttpError, BackendStartingError } from "./api.ts";
import { classifyTransitousResult, classifyTransitousError } from "./transitousOutcome.ts";

describe("classifyTransitousResult", () => {
  it("results when non-empty, empty when zero itineraries", () => {
    expect(classifyTransitousResult([{ legs: [] } as never])).toEqual({
      kind: "results", itineraries: [{ legs: [] }],
    });
    expect(classifyTransitousResult([])).toEqual({ kind: "empty" });
  });
});

describe("classifyTransitousError", () => {
  it("HttpError (incl 429) and BackendStartingError -> failure", () => {
    expect(classifyTransitousError(new HttpError(429, "rate"), true)).toEqual({ kind: "failure" });
    expect(classifyTransitousError(new HttpError(502, "up"), true)).toEqual({ kind: "failure" });
    expect(classifyTransitousError(new BackendStartingError("boot"), true)).toEqual({ kind: "failure" });
  });
  it("timeout/abort -> offline when offline, failure when online", () => {
    const abort = new DOMException("Aborted", "AbortError");
    expect(classifyTransitousError(abort, false)).toEqual({ kind: "offline" });
    expect(classifyTransitousError(abort, true)).toEqual({ kind: "failure" });
  });
  it("bare network error -> offline when offline, failure when online", () => {
    expect(classifyTransitousError(new TypeError("Failed to fetch"), false)).toEqual({ kind: "offline" });
    expect(classifyTransitousError(new TypeError("Failed to fetch"), true)).toEqual({ kind: "failure" });
  });
});
