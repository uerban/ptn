import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feedStartDateIso, readSidecars } from "./sidecars.js";

let tmp: string;
let base: string;

const META = {
  schemaVersion: 1,
  producerGitSha: "test-sha",
  feedStartDate: "2026-01-15",
  feeds: [
    {
      url: "https://example/feed.zip",
      blobSha256: "0".repeat(64),
      etag: '"W/\\"abc\\""',
    },
  ],
};

const META_FULL = {
  schemaVersion: 1,
  producerGitSha: "test-sha-full",
  feedStartDate: "2026-03-10",
  cityTzIana: "Europe/Vilnius",
  derivedInseatRules: 2,
  feeds: [
    {
      url: "https://example/feed.zip",
      blobSha256: "2".repeat(64),
      etag: null,
    },
  ],
};

const SHAPES = {
  schemaVersion: 1,
  shapes: [
    {
      shapeId: "SH_A",
      points: [
        { lat: 54.69, lon: 25.28, shape_dist_traveled: 0.0 },
        { lat: 54.691, lon: 25.281, shape_dist_traveled: 150.0 },
      ],
      tripRefCount: 3,
    },
  ],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ptb-sidecars-"));
  base = join(tmp, "bundle.ptb");
  writeFileSync(`${base}.meta.json`, JSON.stringify(META));
  writeFileSync(`${base}.shapes.json`, JSON.stringify(SHAPES));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readSidecars — happy path", () => {
  it("parses both sidecars and round-trips fields", () => {
    const { meta, shapes } = readSidecars(base);
    expect(meta.producerGitSha).toBe("test-sha");
    expect(meta.feedStartDate).toBe("2026-01-15");
    expect(meta.feeds).toHaveLength(1);
    expect(meta.feeds[0].blobSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.feeds[0].etag).toBe('"W/\\"abc\\""');
    expect(shapes.shapes[0].shapeId).toBe("SH_A");
    expect(shapes.shapes[0].points[0].lat).toBeCloseTo(54.69, 2);
    expect(shapes.shapes[0].tripRefCount).toBe(3);
  });

  it("preserves null etag as null (not omitted)", () => {
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({ ...META, feeds: [{ ...META.feeds[0], etag: null }] }),
    );
    const { meta } = readSidecars(base);
    expect(meta.feeds[0].etag).toBeNull();
  });

  it("preserves null shape_dist_traveled vs absent (both legal)", () => {
    writeFileSync(
      `${base}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [
          {
            shapeId: "SH_X",
            points: [
              { lat: 1, lon: 2, shape_dist_traveled: null },
              { lat: 3, lon: 4 },
            ],
            tripRefCount: 1,
          },
        ],
      }),
    );
    const { shapes } = readSidecars(base);
    expect(shapes.shapes[0].points[0].shape_dist_traveled).toBeNull();
    expect(shapes.shapes[0].points[1].shape_dist_traveled).toBeUndefined();
  });

  it("round-trips multi-byte UTF-8 in URLs and shapeIds", () => {
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({
        ...META,
        feeds: [{ ...META.feeds[0], url: "https://example/Šiauliai/feed.zip" }],
      }),
    );
    writeFileSync(
      `${base}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [{ shapeId: "SH_Ä", points: [{ lat: 1, lon: 2 }], tripRefCount: 1 }],
      }),
    );
    const { meta, shapes } = readSidecars(base);
    expect(meta.feeds[0].url).toBe("https://example/Šiauliai/feed.zip");
    expect(shapes.shapes[0].shapeId).toBe("SH_Ä");
  });

  it("exposes the optional cityTzIana and derivedInseatRules", () => {
    writeFileSync(`${base}.meta.json`, JSON.stringify(META_FULL));
    const { meta } = readSidecars(base);
    expect(meta.schemaVersion).toBe(1);
    expect(meta.producerGitSha).toBe("test-sha-full");
    expect(meta.cityTzIana).toBe("Europe/Vilnius");
    expect(meta.derivedInseatRules).toBe(2);
    expect(meta.feedStartDate).toBe("2026-03-10");
    expect(meta.feeds).toHaveLength(1);
    expect(meta.feeds[0].etag).toBeNull();
  });

  it("tolerates absent cityTzIana and derivedInseatRules", () => {
    const { meta } = readSidecars(base);
    expect(meta.cityTzIana).toBeUndefined();
    expect(meta.derivedInseatRules).toBeUndefined();
  });

  it("accepts a three-feed array preserving order (Krakow-shaped)", () => {
    const feeds = [
      { url: "https://a/feed.zip", blobSha256: "a".repeat(64), etag: '"a"' },
      { url: "https://b/feed.zip", blobSha256: "b".repeat(64), etag: null },
      { url: "https://c/feed.zip", blobSha256: "c".repeat(64), etag: '"c"' },
    ];
    writeFileSync(`${base}.meta.json`, JSON.stringify({ ...META, feeds }));
    const { meta } = readSidecars(base);
    expect(meta.feeds.map((f) => f.url)).toEqual([
      "https://a/feed.zip",
      "https://b/feed.zip",
      "https://c/feed.zip",
    ]);
    expect(meta.feeds[1].etag).toBeNull();
  });
});

describe("readSidecars — negative path", () => {
  it("throws when meta.json is missing", () => {
    rmSync(`${base}.meta.json`);
    expect(() => readSidecars(base)).toThrow(/sidecar missing.*meta\.json/);
  });

  it("throws when shapes.json is missing", () => {
    rmSync(`${base}.shapes.json`);
    expect(() => readSidecars(base)).toThrow(/sidecar missing.*shapes\.json/);
  });

  it("throws on unknown schemaVersion in meta", () => {
    writeFileSync(`${base}.meta.json`, JSON.stringify({ ...META, schemaVersion: 99 }));
    expect(() => readSidecars(base)).toThrow(/meta\.schemaVersion/);
  });

  it("rejects every meta schemaVersion but 1", () => {
    for (const v of [0, 2, 3]) {
      writeFileSync(`${base}.meta.json`, JSON.stringify({ ...META, schemaVersion: v }));
      expect(() => readSidecars(base), `schemaVersion ${v}`).toThrow(/meta\.schemaVersion/);
    }
  });

  it("requires producerGitSha (the old probeGitSha name is not read)", () => {
    const { producerGitSha: _drop, ...rest } = META;
    writeFileSync(`${base}.meta.json`, JSON.stringify({ ...rest, probeGitSha: "legacy" }));
    expect(() => readSidecars(base)).toThrow(/producerGitSha/);
  });

  it("throws on unknown schemaVersion in shapes", () => {
    writeFileSync(
      `${base}.shapes.json`,
      JSON.stringify({ schemaVersion: 2, shapes: [] }),
    );
    expect(() => readSidecars(base)).toThrow(/shapes\.schemaVersion/);
  });

  it("throws on malformed JSON in meta", () => {
    writeFileSync(`${base}.meta.json`, "{not json");
    expect(() => readSidecars(base)).toThrow();
  });

  it("throws when blobSha256 is not 64 hex chars", () => {
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({ ...META, feeds: [{ ...META.feeds[0], blobSha256: "shorthex" }] }),
    );
    expect(() => readSidecars(base)).toThrow(/blobSha256/);
  });

  it("throws when etag is the wrong type", () => {
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({ ...META, feeds: [{ ...META.feeds[0], etag: 12345 }] }),
    );
    expect(() => readSidecars(base)).toThrow(/etag/);
  });

  it("throws when feedStartDate is missing", () => {
    const { feedStartDate: _drop, ...metaSansFsd } = META;
    writeFileSync(`${base}.meta.json`, JSON.stringify(metaSansFsd));
    expect(() => readSidecars(base)).toThrow(/feedStartDate/);
  });

  it("throws when feedStartDate has wrong format", () => {
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({ ...META, feedStartDate: "2026/01/15" }),
    );
    expect(() => readSidecars(base)).toThrow(/feedStartDate/);
  });

  it("throws when shapes points lat is missing", () => {
    writeFileSync(
      `${base}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [{ shapeId: "S", points: [{ lon: 1 }] }],
      }),
    );
    expect(() => readSidecars(base)).toThrow(/lat/);
  });

  it("throws when tripRefCount is missing", () => {
    writeFileSync(
      `${base}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [{ shapeId: "S", points: [{ lat: 1, lon: 2 }] }],
      }),
    );
    expect(() => readSidecars(base)).toThrow(/tripRefCount/);
  });

  it("throws when tripRefCount is negative or non-integer", () => {
    writeFileSync(
      `${base}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [{ shapeId: "S", points: [{ lat: 1, lon: 2 }], tripRefCount: -1 }],
      }),
    );
    expect(() => readSidecars(base)).toThrow(/tripRefCount/);
  });
});

describe("feedStartDateIso", () => {
  it("converts a YYYYMMDD integer to ISO", () => {
    expect(feedStartDateIso(20260501)).toBe("2026-05-01");
    expect(feedStartDateIso(20260108)).toBe("2026-01-08"); // zero-padding
  });
  it("maps the 0 sentinel to 1970-01-01 (matches the producer's format_ymd)", () => {
    expect(feedStartDateIso(0)).toBe("1970-01-01");
  });
});
