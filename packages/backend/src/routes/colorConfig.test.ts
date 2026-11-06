import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { GtfsStore } from "../gtfs/store.js";
import { createColorConfigHandler } from "./colorConfig.js";

describe("color config cache policy", () => {
  for (const available of [true, false]) {
    it(available ? "caches GTFS defaults for a day" : "does not cache unavailable defaults for a day", async () => {
      const app = Fastify();
      const config = available ? { modes: [] } : null;
      const store = { getColorConfig: () => config } as unknown as GtfsStore;
      app.get("/color-config", createColorConfigHandler(store));
      try {
        const response = await app.inject({ method: "GET", url: "/color-config" });
        expect(response.statusCode).toBe(available ? 200 : 503);
        expect(response.headers["cache-control"]).toBe(available ? "public, max-age=86400" : undefined);
      } finally {
        await app.close();
      }
    });
  }
});
