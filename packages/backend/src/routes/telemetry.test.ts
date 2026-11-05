import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { createTelemetryHandler, type TelemetryEvent } from "./telemetry.js";

function mkApp() {
  const emitted: TelemetryEvent[] = [];
  const app = Fastify({ logger: false });
  app.post("/api/telemetry", createTelemetryHandler({ emit: (e) => emitted.push(e) }));
  return { app, emitted };
}

describe("telemetry route", () => {
  it("204 No Content on the four allowlisted events", async () => {
    const { app, emitted } = mkApp();
    const res = await app.inject({
      method: "POST", url: "/api/telemetry",
      payload: [
        { event: "sanity_clamp", value: 1 },
        { event: "bundle_thrash", value: 1 },
        { event: "truncated_lookahead", value: 1 },
        { event: "absurd_countdown", value: 8400 },
      ],
    });
    expect(res.statusCode).toBe(204);
    expect(emitted).toHaveLength(4);
    expect(emitted.map((e) => e.event).sort()).toEqual([
      "absurd_countdown", "bundle_thrash", "sanity_clamp", "truncated_lookahead",
    ]);
  });

  it("400 INVALID_BODY when body is not an array", async () => {
    const { app } = mkApp();
    const res = await app.inject({ method: "POST", url: "/api/telemetry", payload: { event: "sanity_clamp" } });
    expect(res.statusCode).toBe(400);
  });

  it("400 TOO_MANY_EVENTS when array length > 100", async () => {
    const { app } = mkApp();
    const big = Array.from({ length: 101 }, () => ({ event: "sanity_clamp" }));
    const res = await app.inject({ method: "POST", url: "/api/telemetry", payload: big });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("TOO_MANY_EVENTS");
  });

  it("400 INVALID_EVENT_NAME on events outside the allowlist", async () => {
    const { app } = mkApp();
    const res = await app.inject({ method: "POST", url: "/api/telemetry", payload: [{ event: "pt_arbitrary_event" }] });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_EVENT_NAME");
  });

  it("400 INVALID_EVENT_VALUE on non-finite number", async () => {
    const { app } = mkApp();
    const res = await app.inject({ method: "POST", url: "/api/telemetry", payload: [{ event: "sanity_clamp", value: "nope" }] });
    expect(res.statusCode).toBe(400);
  });

  it("400 INVALID_EVENT_TAGS when more than 8 tag keys", async () => {
    const { app } = mkApp();
    const tags: Record<string, string> = {};
    for (let i = 0; i < 9; i++) tags[`k${i}`] = "v";
    const res = await app.inject({
      method: "POST", url: "/api/telemetry",
      payload: [{ event: "sanity_clamp", tags }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_EVENT_TAGS");
  });

  it("400 INVALID_EVENT_TAG when a tag value is longer than 64 chars", async () => {
    const { app } = mkApp();
    const res = await app.inject({
      method: "POST", url: "/api/telemetry",
      payload: [{ event: "sanity_clamp", tags: { city: "x".repeat(65) } }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_EVENT_TAG");
  });

  it("400 INVALID_EVENT_TAG_KEY when a tag key violates the regex", async () => {
    const { app } = mkApp();
    const res = await app.inject({
      method: "POST", url: "/api/telemetry",
      payload: [{ event: "sanity_clamp", tags: { "Bad-Key": "v" } }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_EVENT_TAG_KEY");
  });

  it("204 with valid tags emits the tags through to the deps.emit callback", async () => {
    const { app, emitted } = mkApp();
    const res = await app.inject({
      method: "POST", url: "/api/telemetry",
      payload: [{ event: "sanity_clamp", value: 1, tags: { city: "vilnius", route: "1" } }],
    });
    expect(res.statusCode).toBe(204);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.tags).toEqual({ city: "vilnius", route: "1" });
  });
});
