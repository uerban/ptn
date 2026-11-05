import { describe, it, expect, vi } from "vitest";
import { reportTelemetry } from "../../src/services/errorReporter.ts";

describe("reportTelemetry", () => {
  it("emits a structured info message", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reportTelemetry("leg_geometry_source", { source: "shape", count: 1 });
    expect(info).toHaveBeenCalledWith(
      "[telemetry]",
      expect.objectContaining({ event: "leg_geometry_source", data: { source: "shape", count: 1 } }),
    );
    info.mockRestore();
  });

  it("never throws", () => {
    expect(() => reportTelemetry("foo", {})).not.toThrow();
  });
});
