import { beforeEach, describe, expect, it, vi } from "vitest";
import { onStorageKeyChange, withMigrationLock } from "./crossTab.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("onStorageKeyChange", () => {
  it("reacts to the watched key and to clear(), not to other keys", () => {
    const onChange = vi.fn();
    const stop = onStorageKeyChange("ptn-a", onChange, window);
    window.dispatchEvent(new StorageEvent("storage", { key: "ptn-b" }));
    expect(onChange).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: "ptn-a" }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new StorageEvent("storage", { key: "ptn-a" }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("withMigrationLock", () => {
  it("uses Web Locks when available", async () => {
    const request = vi.fn(
      async (_name: string, _opts: unknown, cb: () => Promise<number>) => cb(),
    );
    const result = await withMigrationLock("m", () => 7, {
      locks: { request: request as never },
    });
    expect(result).toBe(7);
    expect(request).toHaveBeenCalledWith(
      "ptn-m",
      { mode: "exclusive" },
      expect.any(Function),
    );
  });

  it("serializes holders through the localStorage lease", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withMigrationLock(
      "m",
      () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          release = () => {
            order.push("first:end");
            resolve();
          };
        }),
      { locks: null, retryMs: 1 },
    );
    const second = withMigrationLock(
      "m",
      () => {
        order.push("second");
      },
      { locks: null, retryMs: 1 },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(localStorage.getItem("ptn-lock:m")).toBeNull();
  });

  it("takes over an expired lease left by a crashed tab", async () => {
    localStorage.setItem(
      "ptn-lock:m",
      JSON.stringify({ owner: "gone", expires: 100 }),
    );
    const fn = vi.fn(() => "ran");
    await expect(
      withMigrationLock("m", fn, { locks: null, now: () => 200 }),
    ).resolves.toBe("ran");
    expect(localStorage.getItem("ptn-lock:m")).toBeNull();
  });

  it("a holder that outlives its lease never removes the next holder's lease", async () => {
    let clock = 0;
    const now = () => clock;
    let finishFirst!: () => void;
    const first = withMigrationLock(
      "m",
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
      { locks: null, now, leaseMs: 100 },
    );
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem("ptn-lock:m")!).expires).toBe(100);

    // The first holder stalls past its lease; a second tab takes over.
    clock = 150;
    let secondRunning = false;
    let finishSecond!: () => void;
    const second = withMigrationLock(
      "m",
      () =>
        new Promise<void>((resolve) => {
          secondRunning = true;
          finishSecond = resolve;
        }),
      { locks: null, now, leaseMs: 100, sleep: async () => {} },
    );
    await vi.waitFor(() => expect(secondRunning).toBe(true));
    const secondLease = localStorage.getItem("ptn-lock:m");

    finishFirst();
    await first;
    expect(localStorage.getItem("ptn-lock:m")).toBe(secondLease);

    finishSecond();
    await second;
    expect(localStorage.getItem("ptn-lock:m")).toBeNull();
  });

  it("runs without coordination when storage is unavailable", async () => {
    await expect(
      withMigrationLock("m", () => 1, { locks: null, storage: null }),
    ).resolves.toBe(1);
  });

  it("releases the lease when the migration throws", async () => {
    await expect(
      withMigrationLock(
        "m",
        () => {
          throw new Error("fail");
        },
        { locks: null },
      ),
    ).rejects.toThrow("fail");
    expect(localStorage.getItem("ptn-lock:m")).toBeNull();
  });
});
