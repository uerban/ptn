import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import {
  findLeaks,
  rawLocalStorageText,
  rawTableText,
  resetPersonalStorage,
} from "./personalStorage.ts";

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const out = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(out).set(encoded);
  return out;
}

// "Dom4242" and "home1234" are valid base64 characters, so these payloads
// spell the needles exactly as random ciphertext could.
const ENVELOPE = JSON.stringify({
  format: "ptn-sealed",
  v: 1,
  iv: "Dom4242xhome",
  ct: "S1234Domhome54351abc+/==",
});

beforeEach(async () => {
  localStorage.clear();
  await resetPersonalStorage();
});

describe("findLeaks", () => {
  it("ignores needles inside a sealed localStorage envelope", () => {
    localStorage.setItem("favorites", ENVELOPE);
    expect(findLeaks(rawLocalStorageText(), ["Dom", "4242", "home", "1234", "5435"])).toEqual([]);
  });

  it("reports the same needles in plaintext next to an envelope", () => {
    localStorage.setItem("favorites", ENVELOPE);
    localStorage.setItem("viewport", '{"label":"Dom","lat":54.3521}');
    expect(findLeaks(rawLocalStorageText(), ["Dom", "54.35", "4242"])).toEqual(["Dom", "54.35"]);
    expect(findLeaks(`${ENVELOPE}Dom`, ["Dom"])).toEqual(["Dom"]);
  });

  it("keeps an envelope whose payload is not base64 searchable", () => {
    const broken = JSON.stringify({ format: "ptn-sealed", v: 1, iv: "x", ct: "Dom home" });
    expect(findLeaks(broken, ["Dom"])).toEqual(["Dom"]);
  });

  it("ignores needles inside encrypted-record buffers of a table row", async () => {
    await db.geocoderDedup.put({
      queryHash: "q1",
      iv: bytes("Dom"),
      ct: bytes("S-42 4242 home"),
      createdAt: 0,
      providerId: "photon",
      gridMeters: 0,
    } as never);
    const raw = await rawTableText("geocoderDedup");
    expect(raw).toContain("<sealed:");
    expect(findLeaks(raw, ["Dom", "S-42", "4242", "home"])).toEqual([]);
  });

  it("reports plaintext fields and non-ciphertext buffers of a table row", async () => {
    await db.savedLocations.put({
      id: "s1",
      alias: "Dom",
      endpoint: { lat: 54.3521, label: bytes("home") },
      aliasCipher: { v: 1, iv: bytes("4242"), ct: bytes("S-42") },
      savedAt: 0,
      encrypted: true,
    } as never);
    const raw = await rawTableText("savedLocations");
    expect(findLeaks(raw, ["Dom", "54.35", "home", "4242", "S-42"])).toEqual([
      "Dom",
      "54.35",
      "home",
    ]);
  });
});
