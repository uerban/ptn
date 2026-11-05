import { describe, it, expect } from "vitest";
import { walkStepParts, walkStepText } from "../../src/utils/walkStepText.ts";

const t = (_key: string, fallback?: string) => fallback ?? _key;

describe("walkStepText", () => {
  it("puts the street after the turn, with no grammar around it", () => {
    expect(walkStepText(t, { kind: "turn", turn: "left", name: "Pylimo g.", distanceToStartMeters: 42.4 }))
      .toBe("42 m · Turn left · Pylimo g.");
  });

  it("omits the street when unnamed", () => {
    expect(walkStepText(t, { kind: "turn", turn: "slight-right", name: "", distanceToStartMeters: 10 }))
      .toBe("10 m · Turn slightly right");
  });

  it("phrases crossings, stairs and arrival", () => {
    expect(walkStepText(t, { kind: "cross", name: "", distanceToStartMeters: 5 })).toBe("5 m · Cross the street");
    expect(walkStepText(t, { kind: "stairs", name: "", distanceToStartMeters: 20 })).toBe("20 m · Take the stairs");
    expect(walkStepText(t, { kind: "arrive", name: "", distanceToStartMeters: 30 })).toBe("30 m · Arrive");
  });

  it("treats a missing turn as continuing", () => {
    expect(walkStepText(t, { kind: "turn", name: "Gedimino pr.", distanceToStartMeters: 3 }))
      .toBe("3 m · Continue · Gedimino pr.");
  });

  it("looks up underscored keys and the shared metres unit", () => {
    const keys: string[] = [];
    walkStepText((k, f) => { keys.push(k); return f ?? k; }, { kind: "turn", turn: "sharp-left", name: "", distanceToStartMeters: 1 });
    expect(keys).toEqual(expect.arrayContaining(["walk.turn.sharp_left", "unit.meters"]));
  });

  it("says the turn into a crossing or stairs as its own instruction", () => {
    expect(walkStepText(t, { kind: "cross", turn: "left", name: "Pylimo g.", distanceToStartMeters: 8 }))
      .toBe("8 m · Turn left · Cross the street");
    expect(walkStepText(t, { kind: "stairs", turn: "sharp-right", name: "", distanceToStartMeters: 12 }))
      .toBe("12 m · Turn sharp right · Take the stairs");
  });

  it("translates every part whole, composing nothing", () => {
    const tr = (k: string) => `<${k}>`;
    expect(walkStepParts(tr, { kind: "stairs", turn: "u-turn", name: "", distanceToStartMeters: 7 })).toEqual({
      distance: "<unit.meters>",
      actions: ["<walk.turn.u_turn>", "<walk.step.stairs>"],
    });
  });

  it("keeps the plain crossing when the turn is straight or unknown", () => {
    expect(walkStepText(t, { kind: "cross", turn: "straight", name: "", distanceToStartMeters: 4 }))
      .toBe("4 m · Cross the street");
    expect(walkStepText(t, { kind: "stairs", turn: "sideways", name: "", distanceToStartMeters: 4 }))
      .toBe("4 m · Take the stairs");
  });
});
