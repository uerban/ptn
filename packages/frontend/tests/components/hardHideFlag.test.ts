import { describe, it, expect } from "vitest";
import { hardHideLabelsEnabled } from "../../src/components/Map/hardHideFlag.ts";

const ls = (v: string | null) => ({ getItem: (_k: string) => v });

describe("hardHideLabelsEnabled (Stage 1b: default-ON + rollback levers)", () => {
  it("defaults ON when nothing is set (the Stage 1b flip)", () => {
    expect(hardHideLabelsEnabled(undefined, undefined)).toBe(true);
    expect(hardHideLabelsEnabled(ls(null), undefined)).toBe(true);
  });

  it('rolls back via localStorage "ptn.hardHideLabels"="0"', () => {
    expect(hardHideLabelsEnabled(ls("0"), undefined)).toBe(false);
  });

  it('rolls back via env VITE_PT_HARD_HIDE_LABELS="0"', () => {
    expect(hardHideLabelsEnabled(undefined, "0")).toBe(false);
  });

  it('stays ON for any non-"0" value (legacy "1", or anything else)', () => {
    expect(hardHideLabelsEnabled(ls("1"), undefined)).toBe(true);
    expect(hardHideLabelsEnabled(ls("yes"), "1")).toBe(true);
    expect(hardHideLabelsEnabled(ls(""), "")).toBe(true);
  });
});
