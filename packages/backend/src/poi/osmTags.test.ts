import { describe, it, expect } from "vitest";
import { loadTagSpec, parseRule, parseTagSpec } from "./osmTags.js";

describe("osmTags.yaml", () => {
  const spec = loadTagSpec();

  it("loads both strict and loose tiers", () => {
    expect(Object.keys(spec)).toEqual(["strict", "loose"]);
  });

  it("strict tier includes named destination categories", () => {
    expect(Object.keys(spec.strict).sort()).toEqual([
      "civic",
      "culture",
      "mall",
      "named_junction",
      "named_square",
      "outdoor",
      "public_building",
      "recreation",
      "transit_entrance",
    ]);
  });

  it("loose tier adds bus stops, schools, tourism, retail", () => {
    expect(Object.keys(spec.loose).sort()).toEqual([
      "kindergarten",
      "named_bus_stop",
      "retail",
      "school",
      "tourism",
    ]);
  });

  it("strict.transit_entrance has expected include/exclude counts", () => {
    const cat = spec.strict.transit_entrance;
    expect(cat.include).toHaveLength(6);
    expect(cat.exclude).toHaveLength(3);
    expect(cat.nameRequired).toBe(true);
    expect(cat.qualifiers).toHaveLength(1);
  });

  it("strict.named_junction requires name", () => {
    const cat = spec.strict.named_junction;
    expect(cat.include).toHaveLength(2);
    expect(cat.nameRequired).toBe(true);
  });

  it("strict.public_building excludes dorms/clinics/schools", () => {
    const cat = spec.strict.public_building;
    expect(cat.include.length).toBeGreaterThanOrEqual(6);
    const excludedKeys = cat.exclude.flatMap((r) => r.predicates.map((p) => `${p.kind === "exact" ? p.key + "=" + p.values.join("|") : p.key + "=*"}`));
    expect(excludedKeys).toContain("amenity=clinic");
    expect(excludedKeys).toContain("building=dormitory");
    expect(excludedKeys).toContain("amenity=school");
  });

  it("strict.named_square includes place=square, pedestrian plaza, leisure=plaza", () => {
    const cat = spec.strict.named_square;
    expect(cat.include).toHaveLength(3);
    expect(cat.nameRequired).toBe(true);
  });

  it("loose.named_bus_stop requires name", () => {
    const cat = spec.loose.named_bus_stop;
    expect(cat.include).toHaveLength(1);
    expect(cat.include[0].predicates[0]).toEqual({
      kind: "exact",
      key: "highway",
      values: ["bus_stop"],
    });
    expect(cat.nameRequired).toBe(true);
  });

  it("loose.tourism uses wildcard and excludes info kiosks and viewpoints", () => {
    const cat = spec.loose.tourism;
    expect(cat.include[0].predicates).toEqual([
      { kind: "present", key: "tourism" },
      { kind: "present", key: "name" },
    ]);
    expect(cat.exclude[0].predicates).toEqual([
      { kind: "exact", key: "tourism", values: ["information", "museum"] },
    ]);
    expect(cat.exclude[1].predicates).toEqual([
      { kind: "exact", key: "tourism", values: ["viewpoint"] },
    ]);
  });
});

describe("parseRule", () => {
  it("parses single key=value", () => {
    const rule = parseRule("railway=station");
    expect(rule.predicates).toEqual([
      { kind: "exact", key: "railway", values: ["station"] },
    ]);
  });

  it("parses wildcard as present predicate", () => {
    const rule = parseRule("name=*");
    expect(rule.predicates).toEqual([{ kind: "present", key: "name" }]);
  });

  it("parses pipe-separated values", () => {
    const rule = parseRule("station=subway|light_rail|monorail");
    expect(rule.predicates).toEqual([
      { kind: "exact", key: "station", values: ["subway", "light_rail", "monorail"] },
    ]);
  });

  it("parses AND-ed predicates joined by +", () => {
    const rule = parseRule("railway=tram_stop + name=*");
    expect(rule.predicates).toEqual([
      { kind: "exact", key: "railway", values: ["tram_stop"] },
      { kind: "present", key: "name" },
    ]);
  });
});

describe("parseTagSpec error handling", () => {
  it("rejects YAML missing a tier", () => {
    expect(() => parseTagSpec("strict: {}\n")).toThrow(/tier 'loose'/);
  });

  it("rejects a predicate without '='", () => {
    const bad = "strict:\n  x:\n    include:\n      - railway\n    name_required: true\nloose: {}\n";
    expect(() => parseTagSpec(bad)).toThrow(/missing '='/);
  });
});
