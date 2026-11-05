#!/usr/bin/env node
// Verify that every locale JSON under packages/frontend/src/i18n/locales
// has the same flattened keyset as en.json. Three modes:
//
//   node scripts/check-i18n-parity.mjs
//       Validate that every locale file is parseable JSON, then check
//       keyset parity. Exit 0 on success, exit 1 on any syntax error or
//       missing/extra key. Used by the i18n-parity CI job. Extras (keys
//       present in the locale but absent from en.json) are reported so
//       typos and stale keys do not silently linger.
//
//   node scripts/check-i18n-parity.mjs --syntax-only
//       Validate JSON parseability only — skip the keyset comparison.
//       Used as a fast deploy/build preflight (frontend prebuild hook)
//       so a malformed locale file aborts with a clear per-file message
//       before tsc emits an opaque TS1005 from JSON import resolution.
//
//   node scripts/check-i18n-parity.mjs --mark-untranslated
//       For every missing key, declare it in
//       packages/frontend/i18n-untranslated.json so the locale may ship
//       without it. Prefer this to --fix-with-fallback: every t() call site
//       passes an inline English fallback, so a key absent from a locale
//       renders exactly the same text as a key holding a copy of the English
//       string — the copy is pure payload. CI must NEVER invoke this flag.
//
//   node scripts/check-i18n-parity.mjs --fix-with-fallback
//       For every missing key, write the EN value into the locale file
//       and seed the i18n review queue notes so a native speaker can
//       replace the fallback later. Extras are reported but never
//       deleted — removing them is a human decision. CI workflows must
//       NEVER invoke this flag — it mutates the tree.
//
// The exported checkParity() / fixWithFallback() / validateLocalesSyntax()
// functions exist so the behaviour can be unit-tested with tmp fixtures
// (see packages/frontend/tests/i18n/parity.test.ts).

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_LOCALES_DIR = resolve(
  REPO_ROOT,
  "packages/frontend/src/i18n/locales",
);
const DEFAULT_REVIEW_QUEUE = resolve(REPO_ROOT, "docs/i18n-review-queue.md");
// Keys a locale is allowed to omit because nobody has translated them yet.
// Deliberately outside src/ so it can never be pulled into the bundle.
const DEFAULT_UNTRANSLATED = resolve(
  REPO_ROOT,
  "packages/frontend/i18n-untranslated.json",
);

// { "<locale>": ["dotted.key", ...] }. A missing or unreadable file means
// "nothing is declared untranslated", i.e. the original strict behaviour.
function readUntranslated(path) {
  if (!path || !existsSync(path)) return {};
  const parsed = readJson(path);
  const out = {};
  for (const [locale, keys] of Object.entries(parsed)) {
    out[locale] = new Set(Array.isArray(keys) ? keys : []);
  }
  return out;
}

// Walk a JSON object recursively and yield a Map of every leaf's dotted
// path → { value, accessPath }. The accessPath is the ordered list of
// literal property keys to traverse, so a flat key like
// "settings.title" stays one step and a nested { settings: { title } }
// stays two — preserving whatever shape en.json uses when we write back.
function flattenWithAccess(obj) {
  const out = new Map();
  function walk(node, dottedPrefix, accessPrefix) {
    for (const [k, v] of Object.entries(node)) {
      const dotted = dottedPrefix ? `${dottedPrefix}.${k}` : k;
      const access = [...accessPrefix, k];
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        walk(v, dotted, access);
      } else {
        out.set(dotted, { value: v, accessPath: access });
      }
    }
  }
  walk(obj, "", []);
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateLocalesSyntax(localesDir) {
  const files = readdirSync(localesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const errors = [];
  for (const f of files) {
    try {
      readJson(join(localesDir, f));
    } catch (err) {
      errors.push({ locale: basename(f, ".json"), error: err.message });
    }
  }
  return errors;
}

// untranslatedPath is opt-in: with no manifest every en.json key must be
// present in every locale, which is what the fixture-based unit tests rely on.
// The CLI passes DEFAULT_UNTRANSLATED explicitly.
export function checkParity(localesDir, untranslatedPath = null) {
  const untranslated = readUntranslated(untranslatedPath);
  const files = readdirSync(localesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.includes("en.json")) {
    throw new Error(`en.json not found in ${localesDir}`);
  }
  const enKeys = new Set(
    flattenWithAccess(readJson(join(localesDir, "en.json"))).keys(),
  );

  const result = [];
  for (const f of files) {
    if (f === "en.json") continue;
    const locale = basename(f, ".json");
    const localeKeys = new Set(
      flattenWithAccess(readJson(join(localesDir, f))).keys(),
    );
    const declared = untranslated[locale] ?? new Set();
    const missing = [];
    const extra = [];
    // A declaration is stale once the key is actually translated, or once
    // it disappears from en.json — either way it must not linger, or the
    // gate quietly stops guarding that key.
    const staleUntranslated = [];
    for (const key of enKeys) {
      if (localeKeys.has(key)) continue;
      if (declared.has(key)) continue;
      missing.push(key);
    }
    for (const key of localeKeys) {
      if (!enKeys.has(key)) extra.push(key);
    }
    for (const key of declared) {
      if (localeKeys.has(key) || !enKeys.has(key)) staleUntranslated.push(key);
    }
    if (
      missing.length > 0 ||
      extra.length > 0 ||
      staleUntranslated.length > 0
    ) {
      // Only carry the new field when it has something to say, so existing
      // callers comparing the whole {locale, missing, extra} shape still hold.
      result.push(
        staleUntranslated.length > 0
          ? { locale, missing, extra, staleUntranslated }
          : { locale, missing, extra },
      );
    }
  }
  result.sort((a, b) => a.locale.localeCompare(b.locale));
  return result;
}

function setAtAccess(obj, accessPath, value) {
  let cur = obj;
  for (let i = 0; i < accessPath.length - 1; i++) {
    const k = accessPath[i];
    if (
      cur[k] == null ||
      typeof cur[k] !== "object" ||
      Array.isArray(cur[k])
    ) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[accessPath[accessPath.length - 1]] = value;
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function ensureReviewQueueHeader(reviewQueuePath) {
  if (existsSync(reviewQueuePath)) return;
  const dir = dirname(reviewQueuePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const header =
    "# i18n Review Queue\n" +
    "\n" +
    "**Owner:** TBD\n" +
    "**SLA:** TBD — native-speaker review pending\n" +
    "\n" +
    "This file lists strings auto-filled with English fallback values by\n" +
    "`scripts/check-i18n-parity.mjs --fix-with-fallback`. Each entry is\n" +
    "a candidate for native-speaker review; remove the line once a real\n" +
    "translation lands.\n" +
    "\n";
  writeFileSync(reviewQueuePath, header, "utf8");
}

/**
 * Declare every currently-missing key as untranslated, restoring parity
 * without shipping a byte of duplicated English.
 *
 * This is the remedy to reach for when a new en.json key lands:
 * --fix-with-fallback copies the English string into all five locales, which
 * is ~190 B gzipped per key that can never render differently from the inline
 * fallback the call site already passes.
 */
export function markUntranslated(localesDir, untranslatedPath) {
  const result = checkParity(localesDir, untranslatedPath);
  const current = existsSync(untranslatedPath)
    ? readJson(untranslatedPath)
    : {};
  for (const { locale, missing } of result) {
    if (missing.length === 0) continue;
    const merged = new Set([...(current[locale] ?? []), ...missing]);
    current[locale] = [...merged].sort();
  }
  writeFileSync(
    untranslatedPath,
    JSON.stringify(current, null, 2) + "\n",
    "utf8",
  );
  return current;
}

export function fixWithFallback(
  localesDir,
  reviewQueuePath,
  { now = new Date() } = {},
) {
  const result = checkParity(localesDir);
  if (result.length === 0) return result;

  const enFlat = flattenWithAccess(readJson(join(localesDir, "en.json")));
  const date = todayIso(now);
  // Defer header creation until we know there is at least one missing key
  // to write — an extras-only mismatch must not leave behind an empty
  // review-queue file (the script's contract is "only fills missing keys").
  let headerEnsured = false;

  for (const { locale, missing } of result) {
    if (missing.length === 0) continue;
    const filePath = join(localesDir, `${locale}.json`);
    const data = readJson(filePath);
    let section = `### ${locale}.json (filled ${date})\n\n`;
    for (const key of missing) {
      const entry = enFlat.get(key);
      if (!entry) continue;
      setAtAccess(data, entry.accessPath, entry.value);
      section += `- [ ] \`${key}\` — \`${String(entry.value).replace(/`/g, "\\`")}\`\n`;
    }
    section += "\n";
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    if (!headerEnsured) {
      ensureReviewQueueHeader(reviewQueuePath);
      headerEnsured = true;
    }
    appendFileSync(reviewQueuePath, section, "utf8");
  }
  return result;
}

function formatSyntaxFailure(errors) {
  let msg = "i18n locale syntax error — broken JSON cannot be parsed:\n\n";
  for (const { locale, error } of errors) {
    msg += `### ${locale}.json\n${error}\n\n`;
  }
  msg +=
    "Fix the syntax error before continuing — parity check, frontend " +
    "build (tsc + vite), and runtime locale loading all require valid JSON.\n";
  return msg;
}

function formatFailure(result) {
  let msg = "i18n parity check FAILED — keyset mismatch vs en.json\n\n";
  for (const entry of result) {
    const { locale, missing, extra } = entry;
    const parts = [];
    if (missing.length > 0) parts.push(`${missing.length} missing`);
    if (extra.length > 0) parts.push(`${extra.length} extra`);
    const stale = entry.staleUntranslated ?? [];
    if (stale.length > 0) parts.push(`${stale.length} stale untranslated`);
    msg += `### ${locale}.json (${parts.join(", ")})\n`;
    if (missing.length > 0) {
      msg += "missing keys (present in en.json, absent in locale):\n";
      for (const key of missing) msg += `- [ ] ${key}\n`;
    }
    if (extra.length > 0) {
      msg += "extra keys (present in locale, absent in en.json — typo or stale?):\n";
      for (const key of extra) msg += `- [ ] ${key}\n`;
    }
    if (stale.length > 0) {
      msg +=
        "stale entries in i18n-untranslated.json (key is translated now, or gone from en.json — drop the entry):\n";
      for (const key of stale) msg += `- [ ] ${key}\n`;
    }
    msg += "\n";
  }
  msg +=
    "Run locally: node scripts/check-i18n-parity.mjs --fix-with-fallback\n" +
    "(--fix-with-fallback only fills missing keys; extras must be reviewed by hand.\n" +
    " Do not invoke --fix-with-fallback from CI.)\n";
  return msg;
}

function isMain() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const args = process.argv.slice(2);

  // Syntax check runs first in every mode — every downstream operation
  // (parity diff, fix-with-fallback, tsc, vite) crashes opaquely on
  // malformed JSON, so surface that as a clear per-file message before
  // anything else touches the files.
  const syntaxErrors = validateLocalesSyntax(DEFAULT_LOCALES_DIR);
  if (syntaxErrors.length > 0) {
    process.stderr.write(formatSyntaxFailure(syntaxErrors));
    process.exit(1);
  }
  if (args.includes("--syntax-only")) {
    process.exit(0);
  }

  if (args.includes("--mark-untranslated")) {
    markUntranslated(DEFAULT_LOCALES_DIR, DEFAULT_UNTRANSLATED);
    const after = checkParity(DEFAULT_LOCALES_DIR, DEFAULT_UNTRANSLATED);
    if (after.length > 0) {
      process.stderr.write(formatFailure(after));
      process.stderr.write(
        "\n--mark-untranslated declared the missing keys but parity is still broken (see above). Extras and stale entries must be resolved by hand.\n",
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--fix-with-fallback")) {
    fixWithFallback(DEFAULT_LOCALES_DIR, DEFAULT_REVIEW_QUEUE);
    // Re-check after the fill — extras are never auto-removed, so a
    // parity failure can still remain. Exit non-zero in that case so
    // the user knows the fix wasn't enough and CI will still fail.
    const after = checkParity(DEFAULT_LOCALES_DIR, DEFAULT_UNTRANSLATED);
    if (after.length > 0) {
      process.stderr.write(formatFailure(after));
      process.stderr.write(
        "\n--fix-with-fallback filled missing keys but parity is still broken (see above). Extras must be removed by hand.\n",
      );
      process.exit(1);
    }
    process.exit(0);
  } else {
    const result = checkParity(DEFAULT_LOCALES_DIR, DEFAULT_UNTRANSLATED);
    if (result.length > 0) {
      process.stderr.write(formatFailure(result));
      process.exit(1);
    }
    process.exit(0);
  }
}
