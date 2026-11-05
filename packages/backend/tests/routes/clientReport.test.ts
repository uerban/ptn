import { describe, it, expect, vi } from "vitest";
import { createClientReportHandler, CLIENT_REPORT_KINDS } from "../../src/routes/clientReport.js";

function mockReply() {
  const reply: any = { _status: 200, _body: undefined };
  reply.status = vi.fn((s: number) => { reply._status = s; return reply; });
  reply.send = vi.fn((b?: unknown) => { reply._body = b; return reply; });
  return reply;
}

describe("client-report handler", () => {
  it("increments the counter for a valid kind and returns 204", async () => {
    const inc = vi.fn();
    const infoSpy = vi.fn();
    const handler = createClientReportHandler({ inc });
    const reply = mockReply();
    await handler({ body: { kind: "no-wasm", appVersion: "1.2.345" }, log: { info: infoSpy } } as any, reply);
    expect(inc).toHaveBeenCalledWith({ kind: "no-wasm" });
    expect(reply._status).toBe(204);
    // Privacy guarantee: the structured log line carries ONLY `kind` — no `ip`, no `appVersion`, no
    // echo of the body. Guards against a future edit enriching the log with request.ip.
    expect(Object.keys(infoSpy.mock.calls[0][0])).toEqual(["kind"]);
  });
  it("rejects an unknown kind with 400 and does not increment", async () => {
    const inc = vi.fn();
    const handler = createClientReportHandler({ inc });
    const reply = mockReply();
    await handler({ body: { kind: "evil", appVersion: "x" }, log: { info: vi.fn() } } as any, reply);
    expect(reply._status).toBe(400);
    expect(inc).not.toHaveBeenCalled();
  });
  it("rejects a non-object body with 400", async () => {
    const handler = createClientReportHandler({ inc: vi.fn() });
    const reply = mockReply();
    await handler({ body: "nope", log: { info: vi.fn() } } as any, reply);
    expect(reply._status).toBe(400);
  });
  it("exposes exactly the five allowed kinds", () => {
    expect([...CLIENT_REPORT_KINDS].sort()).toEqual(["import", "init", "no-wasm", "other", "query"]);
  });
});
