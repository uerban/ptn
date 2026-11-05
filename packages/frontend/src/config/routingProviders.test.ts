import { describe, it, expect } from "vitest";
import { ROUTING_PROVIDERS, getRoutingProvider } from "./routingProviders.ts";

describe("routingProviders", () => {
  it("exposes transitous as a frozen, motis-backed provider config", () => {
    const p = getRoutingProvider("transitous");
    expect(p.id).toBe("transitous");
    expect(p.name).toBe("transitous");
    expect(p.adapter).toBe("motis");
    expect(p.tosUrl).toMatch(/^https?:\/\//);
    expect(p.flowId).toBe("external.remote-routing");
    expect(p.requestFields).toEqual(["from", "to", "departAt"]);
    expect(p.supportedRoutingRequirements).toEqual([]);
    expect(p.requestFields).not.toContain("mobilityProfile");
    expect(Object.isFrozen(p.requestFields)).toBe(true);
    expect(Object.isFrozen(p.supportedRoutingRequirements)).toBe(true);
    expect(Object.isFrozen(ROUTING_PROVIDERS.transitous)).toBe(true);
  });
});
