import { describe, it, expect, beforeEach } from "vitest";
import { MigrationCoordinator } from "./migrationCoordinator.ts";

describe("MigrationCoordinator", () => {
  let coord: MigrationCoordinator;

  beforeEach(() => {
    coord = new MigrationCoordinator();
  });

  it("throws on version collision between different owners", () => {
    coord.reserve({ id: "poiIndex", version: 5, stores: { poiIndex: "id" } });
    expect(() =>
      coord.reserve({ id: "installKey", version: 5, stores: { installKey: "id" } }),
    ).toThrow(/collision/i);
  });

  it("accepts contiguous reservations", () => {
    coord.reserve({ id: "a", version: 2, stores: { a: "id" } });
    coord.reserve({ id: "b", version: 3, stores: { b: "id" } });
    coord.reserve({ id: "c", version: 4, stores: { c: "id" } });
    expect(coord.declaredMigrations().map((m) => m.version)).toEqual([2, 3, 4]);
  });

  it("accepts non-contiguous reservations", () => {
    coord.reserve({ id: "a", version: 2, stores: { a: "id" } });
    coord.reserve({ id: "c", version: 10, stores: { c: "id" } });
    expect(coord.declaredMigrations().map((m) => m.version)).toEqual([2, 10]);
  });

  it("declaredMigrations() returns versions in ascending order", () => {
    coord.reserve({ id: "c", version: 7, stores: { c: "id" } });
    coord.reserve({ id: "a", version: 2, stores: { a: "id" } });
    coord.reserve({ id: "b", version: 5, stores: { b: "id" } });
    expect(coord.declaredMigrations().map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("idempotent reservation (same id + version) is a no-op", () => {
    coord.reserve({ id: "a", version: 2, stores: { a: "id" } });
    expect(() =>
      coord.reserve({ id: "a", version: 2, stores: { a: "id" } }),
    ).not.toThrow();
    expect(coord.declaredMigrations()).toHaveLength(1);
  });

  it("rejects non-integer versions", () => {
    expect(() =>
      coord.reserve({ id: "a", version: 2.5, stores: { a: "id" } }),
    ).toThrow(/integer/i);
  });

  it("rejects versions < 1", () => {
    expect(() =>
      coord.reserve({ id: "a", version: 0, stores: { a: "id" } }),
    ).toThrow(/>=\s*1/);
  });

  it("preserves upgrade callbacks in declaredMigrations()", async () => {
    let called = false;
    const upgrade = async () => {
      called = true;
    };
    coord.reserve({ id: "a", version: 2, stores: { a: "id" }, upgrade });
    const [mig] = coord.declaredMigrations();
    await mig!.upgrade?.({} as never);
    expect(called).toBe(true);
  });
});
