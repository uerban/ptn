import { describe, it, expect, beforeEach } from "vitest";
import {
  isRemoteRoutingProvider,
  isRoutingMode,
  REMOTE_ROUTING_PROVIDERS,
  ROUTING_MODES,
  useSettingsStore,
} from "../../src/stores/settingsStore.ts";

beforeEach(() =>
  useSettingsStore.setState({
    routingMode: "on-device",
    routingProvider: "operator",
  }),
);

describe("settingsStore.routingMode", () => {
  it("defaults to on-device", () => {
    expect(useSettingsStore.getState().routingMode).toBe("on-device");
  });
  it("ROUTING_MODES is the S2b-2a three-mode set", () => {
    expect(ROUTING_MODES).toEqual(["on-device", "provider-fallback", "remote-primary"]);
  });
  it("isRoutingMode guards the union", () => {
    expect(isRoutingMode("provider-fallback")).toBe(true);
    expect(isRoutingMode(42)).toBe(false);
  });
  it("accepts remote-primary via setRoutingMode and isRoutingMode", () => {
    expect(isRoutingMode("remote-primary")).toBe(true);
    useSettingsStore.getState().setRoutingMode("remote-primary");
    expect(useSettingsStore.getState().routingMode).toBe("remote-primary");
  });
  it("setRoutingMode only accepts valid modes", () => {
    useSettingsStore.getState().setRoutingMode("provider-fallback");
    expect(useSettingsStore.getState().routingMode).toBe("provider-fallback");
    useSettingsStore.getState().setRoutingMode("bogus" as never);
    expect(useSettingsStore.getState().routingMode).toBe("provider-fallback"); // unchanged
  });
});

describe("settingsStore.routingProvider", () => {
  it("defaults to operator routing", () => {
    expect(useSettingsStore.getState().routingProvider).toBe("operator");
    expect(REMOTE_ROUTING_PROVIDERS).toEqual(["operator", "transitous"]);
  });

  it("accepts only registered standing providers", () => {
    expect(isRemoteRoutingProvider("operator")).toBe(true);
    expect(isRemoteRoutingProvider("transitous")).toBe(true);
    expect(isRemoteRoutingProvider("unknown")).toBe(false);
    useSettingsStore.getState().setRoutingProvider("transitous");
    useSettingsStore.getState().setRoutingProvider("unknown" as never);
    expect(useSettingsStore.getState().routingProvider).toBe("transitous");
  });

  it("sanitizes an invalid persisted provider to operator", async () => {
    localStorage.setItem(
      "ptn-settings",
      JSON.stringify({
        state: { routingProvider: "unknown" },
        version: 0,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().routingProvider).toBe("operator");
  });
});
