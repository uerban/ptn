import { afterEach, describe, expect, it, vi } from "vitest";
import { tolerantLocalStorage } from "./tolerantLocalStorage.ts";
import {
  newInstallRecord,
  readOnboardingRecord,
  writeOnboardingRecord,
} from "./onboardingRecord.ts";

function refusingStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: () => null,
    getItem: (key) => items.get(key) ?? null,
    setItem: () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
    removeItem: (key) => void items.delete(key),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("tolerantLocalStorage", () => {
  it("stores and reads values", () => {
    tolerantLocalStorage.setItem("k", "v");
    expect(tolerantLocalStorage.getItem("k")).toBe("v");
    tolerantLocalStorage.removeItem("k");
    expect(tolerantLocalStorage.getItem("k")).toBeNull();
  });

  it("does not throw when the browser refuses a write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    expect(() => tolerantLocalStorage.setItem("k", "v")).not.toThrow();
  });
});

describe("onboarding record that cannot be stored", () => {
  it("stays readable for this session", () => {
    const storage = refusingStorage();
    const record = newInstallRecord({ kind: "existing", classifiedAt: 1 });
    expect(writeOnboardingRecord(record, storage)).toBe(false);
    expect(readOnboardingRecord(storage)).toEqual({ status: "ok", record });
  });

  it("is forgotten once a write succeeds, and never leaks to other storage", () => {
    const storage = refusingStorage();
    writeOnboardingRecord(newInstallRecord({ kind: "existing", classifiedAt: 1 }), storage);
    expect(readOnboardingRecord(localStorage)).toEqual({ status: "missing" });

    const stored = newInstallRecord({ kind: "new", classifiedAt: 2 });
    expect(writeOnboardingRecord(stored, localStorage)).toBe(true);
    expect(readOnboardingRecord(localStorage)).toEqual({ status: "ok", record: stored });
  });
});
