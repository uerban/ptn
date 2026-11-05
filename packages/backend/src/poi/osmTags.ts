import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type Predicate =
  | { kind: "present"; key: string }
  | { kind: "exact"; key: string; values: string[] };

export interface Rule {
  predicates: Predicate[];
  raw: string;
}

export interface CategorySpec {
  include: Rule[];
  exclude: Rule[];
  nameRequired: boolean;
  qualifiers: Rule[];
}

import type { Tier } from "@pt/shared";
export type { Tier };
export type TagSpec = Record<Tier, Record<string, CategorySpec>>;

const DEFAULT_YAML_PATH = resolve(import.meta.dirname, "osmTags.yaml");

export function loadTagSpec(yamlPath: string = DEFAULT_YAML_PATH): TagSpec {
  const raw = readFileSync(yamlPath, "utf-8");
  return parseTagSpec(raw);
}

export function parseTagSpec(yamlText: string): TagSpec {
  const doc = parseYaml(yamlText) as Record<string, unknown>;
  const out: TagSpec = { strict: {}, loose: {} };
  for (const tier of ["strict", "loose"] as const) {
    const tierDoc = doc[tier];
    if (!tierDoc || typeof tierDoc !== "object") {
      throw new Error(`osmTags.yaml: missing tier '${tier}'`);
    }
    for (const [category, rawSpec] of Object.entries(tierDoc as Record<string, unknown>)) {
      out[tier][category] = parseCategory(category, rawSpec);
    }
  }
  return out;
}

function parseCategory(name: string, raw: unknown): CategorySpec {
  if (!raw || typeof raw !== "object") {
    throw new Error(`osmTags.yaml: category '${name}' must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  return {
    include: parseRuleList(name, "include", r.include),
    exclude: parseRuleList(name, "exclude", r.exclude ?? []),
    nameRequired: Boolean(r.name_required),
    qualifiers: parseRuleList(name, "qualifiers", r.qualifiers ?? []),
  };
}

function parseRuleList(category: string, field: string, raw: unknown): Rule[] {
  if (!Array.isArray(raw)) {
    throw new Error(`osmTags.yaml: ${category}.${field} must be a list`);
  }
  return raw.map((line, idx) => {
    if (typeof line !== "string") {
      throw new Error(`osmTags.yaml: ${category}.${field}[${idx}] must be a string`);
    }
    return parseRule(line);
  });
}

export function parseRule(line: string): Rule {
  const predicates = line.split("+").map((p) => parsePredicate(p.trim(), line));
  return { predicates, raw: line };
}

function parsePredicate(text: string, context: string): Predicate {
  const eq = text.indexOf("=");
  if (eq < 0) {
    throw new Error(`osmTags.yaml: predicate '${text}' in '${context}' missing '='`);
  }
  const key = text.slice(0, eq).trim();
  const value = text.slice(eq + 1).trim();
  if (!key) {
    throw new Error(`osmTags.yaml: predicate '${text}' has empty key`);
  }
  if (value === "*") {
    return { kind: "present", key };
  }
  return { kind: "exact", key, values: value.split("|").map((v) => v.trim()) };
}
