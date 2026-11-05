import { describe, it, expect } from "vitest";
import { fill } from "../../src/i18n/fill.ts";

describe("fill", () => {
  it("fills every placeholder with its value", () => {
    expect(fill("Line {line} toward {headsign}", { line: "5", headsign: "Centre" })).toBe("Line 5 toward Centre");
  });

  it("inserts values literally: never as a replace pattern", () => {
    // String.prototype.replace with a string would expand these.
    expect(fill("To {stop}", { stop: "$& Plaza" })).toBe("To $& Plaza");
    expect(fill("To {stop}", { stop: "$1 $$ $` $'" })).toBe("To $1 $$ $` $'");
  });

  it("inserts values literally: a value that looks like a placeholder stays as it is", () => {
    expect(fill("{a} and {b}", { a: "{b}", b: "B" })).toBe("{b} and B");
  });

  it("leaves a placeholder without a value as it is", () => {
    expect(fill("{line} at {time}", { line: "5" })).toBe("5 at {time}");
    expect(fill("{line}", {})).toBe("{line}");
  });

  it("fills a repeated placeholder everywhere it appears", () => {
    expect(fill("{n} of {n}", { n: "3" })).toBe("3 of 3");
  });

  it("an empty value empties its placeholder; text without placeholders is unchanged", () => {
    expect(fill("[{x}]", { x: "" })).toBe("[]");
    expect(fill("No slots here", { x: "y" })).toBe("No slots here");
  });
});
