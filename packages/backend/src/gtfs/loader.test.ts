import { describe, it, expect, afterEach } from "vitest";
import { PatternMode } from "@pt/shared";
import { readPatternMode } from "./loader.js";

describe("readPatternMode", () => {
  const prev = process.env.PT_PATTERN_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PT_PATTERN_MODE;
    else process.env.PT_PATTERN_MODE = prev;
  });

  it("defaults to covering-merge when unset", () => {
    delete process.env.PT_PATTERN_MODE;
    expect(readPatternMode()).toBe(PatternMode.CoveringMerge);
  });

  it("honors an explicit off override", () => {
    process.env.PT_PATTERN_MODE = PatternMode.Off;
    expect(readPatternMode()).toBe(PatternMode.Off);
  });

  it("honors an explicit unbounded override", () => {
    process.env.PT_PATTERN_MODE = PatternMode.Unbounded;
    expect(readPatternMode()).toBe(PatternMode.Unbounded);
  });

  it("falls back to covering-merge for an unknown value", () => {
    process.env.PT_PATTERN_MODE = "bogus";
    expect(readPatternMode()).toBe(PatternMode.CoveringMerge);
  });
});
