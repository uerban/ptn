import { describe, test, expect } from "vitest";
import {
  OVERTHROW_LABELS_TIER1,
  OVERTHROW_LABELS_TIER2,
  OVERTHROW_RESPONSES,
  OVERTHROW_REVEAL_THRESHOLD,
  OVERTHROW_TIER2_THRESHOLD,
  nextOverthrowLine,
  pickDifferent,
  type OverthrowLine,
} from "./overthrow.ts";

describe("nextOverthrowLine", () => {
  test("stays hidden until the reveal threshold", () => {
    for (let n = 0; n < OVERTHROW_REVEAL_THRESHOLD; n++) {
      expect(nextOverthrowLine(n, null)).toBeNull();
    }
    expect(nextOverthrowLine(OVERTHROW_REVEAL_THRESHOLD, null)).not.toBeNull();
  });

  // Regression: the first line used to be a fixed constant, so every user saw
  // the same opening message.
  test("the revealing click is already randomised across runs", () => {
    const labels = new Set<string>();
    const subtexts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const line = nextOverthrowLine(OVERTHROW_REVEAL_THRESHOLD, null);
      labels.add(line!.label);
      subtexts.add(line!.subtext);
    }
    expect(labels.size).toBeGreaterThan(1);
    expect(subtexts.size).toBeGreaterThan(1);
  });

  test("every click past the reveal changes both halves of the line", () => {
    let prev: OverthrowLine | null = nextOverthrowLine(OVERTHROW_REVEAL_THRESHOLD, null);
    for (let n = OVERTHROW_REVEAL_THRESHOLD + 1; n < OVERTHROW_REVEAL_THRESHOLD + 40; n++) {
      const next = nextOverthrowLine(n, prev)!;
      expect(next.label).not.toBe(prev!.label);
      expect(next.subtext).not.toBe(prev!.subtext);
      prev = next;
    }
  });

  test("tier-2 labels only become reachable at the tier-2 threshold", () => {
    const tier2 = new Set<string>(OVERTHROW_LABELS_TIER2);
    for (let i = 0; i < 300; i++) {
      const below = nextOverthrowLine(OVERTHROW_TIER2_THRESHOLD - 1, null)!;
      expect(tier2.has(below.label)).toBe(false);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(nextOverthrowLine(OVERTHROW_TIER2_THRESHOLD, null)!.label);
    }
    expect([...seen].some((label) => tier2.has(label))).toBe(true);
  });

  test("only draws from the declared pools", () => {
    const labels = new Set<string>([...OVERTHROW_LABELS_TIER1, ...OVERTHROW_LABELS_TIER2]);
    const subtexts = new Set<string>(OVERTHROW_RESPONSES);
    for (let i = 0; i < 200; i++) {
      const line = nextOverthrowLine(OVERTHROW_TIER2_THRESHOLD + i, null)!;
      expect(labels.has(line.label)).toBe(true);
      expect(subtexts.has(line.subtext)).toBe(true);
    }
  });
});

describe("pickDifferent", () => {
  test("never returns prev", () => {
    for (let i = 0; i < 100; i++) {
      expect(pickDifferent(["a", "b", "c"], "b")).not.toBe("b");
    }
  });

  test("returns the sole member when prev is not in the pool", () => {
    expect(pickDifferent(["only"], "something else")).toBe("only");
  });
});
