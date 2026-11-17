/** Shared error identity without importing the worker/client lifecycle. */
export class WalkGraphUnavailableError extends Error {
  constructor(readonly cityId: string, readonly reason: "transient" | "superseded") {
    super(`walk graph for ${cityId} unavailable (${reason})`);
    this.name = "WalkGraphUnavailableError";
  }
}
