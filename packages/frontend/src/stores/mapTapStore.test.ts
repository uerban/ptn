import { beforeEach, describe, expect, it } from "vitest";
import { useMapTapStore } from "./mapTapStore.ts";
import { usePrivacyStore } from "./privacyStore.ts";

beforeEach(() => {
  useMapTapStore.setState({ rawTap: null });
  usePrivacyStore.getState().reset();
  globalThis.localStorage?.removeItem("ptn-privacy");
});

describe("useMapTapStore", () => {
  it("emitTap writes a transient raw tap", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    expect(useMapTapStore.getState().rawTap).toEqual({
      lat: 54.687251,
      lon: 25.279734,
    });
  });

  it("clear resets the raw tap", () => {
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    useMapTapStore.getState().clear();
    expect(useMapTapStore.getState().rawTap).toBeNull();
  });

  it("emitTap overwrites a previous transient tap", () => {
    useMapTapStore.getState().emitTap(0, 0);
    useMapTapStore.getState().emitTap(1, 2);
    expect(useMapTapStore.getState().rawTap).toEqual({ lat: 1, lon: 2 });
  });

  it("confirmAsEndpoint returns null when no tap is pending", () => {
    expect(useMapTapStore.getState().confirmAsEndpoint()).toBeNull();
  });

  it("confirmAsEndpoint returns a 'mappoint' BaseEndpoint and clears the raw tap", () => {
    usePrivacyStore.getState().setLevel("baseline");
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    const ep = useMapTapStore.getState().confirmAsEndpoint();
    expect(ep).not.toBeNull();
    expect(ep!.kind).toBe("mappoint");
    expect(ep!.lat).toBe(54.687251);
    expect(ep!.lon).toBe(25.279734);
    expect(useMapTapStore.getState().rawTap).toBeNull();
  });

  it("confirmAsEndpoint applies the active policy's precision (Hardened snap-rounded-50m)", () => {
    usePrivacyStore.getState().setLevel("hardened");
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    const ep = useMapTapStore.getState().confirmAsEndpoint();
    expect(ep).not.toBeNull();
    expect(ep!.kind).toBe("mappoint");
    const latStep = 50 / 111_320;
    const lonStep = 50 / (111_320 * Math.cos((ep!.lat * Math.PI) / 180));
    expect(Math.abs(ep!.lat / latStep - Math.round(ep!.lat / latStep))).toBeLessThan(1e-9);
    expect(Math.abs(ep!.lon / lonStep - Math.round(ep!.lon / lonStep))).toBeLessThan(1e-9);
    // Raw tap consumed.
    expect(useMapTapStore.getState().rawTap).toBeNull();
  });

  it("confirmAsEndpoint at Paranoid uses snap-rounded-100m-no-reverse precision", () => {
    usePrivacyStore.getState().setLevel("paranoid");
    useMapTapStore.getState().emitTap(54.687251, 25.279734);
    const ep = useMapTapStore.getState().confirmAsEndpoint();
    expect(ep).not.toBeNull();
    const latStep = 100 / 111_320;
    expect(Math.abs(ep!.lat / latStep - Math.round(ep!.lat / latStep))).toBeLessThan(1e-9);
  });
});
