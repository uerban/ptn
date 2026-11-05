import { getCurrentLevel, getPolicy } from "../stores/privacyStore";

interface ErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
  context?: Record<string, unknown>;
  timestamp: number;
  url: string;
  userAgent: string;
}

const MAX_BUFFER = 50;
const buffer: ErrorReport[] = [];

interface ConsolePayload {
  stack?: string;
  componentStack?: string;
  context?: Record<string, unknown>;
}

function readPolicySafely(): { errorReporting: boolean; level: string } {
  try {
    return { errorReporting: getPolicy().errorReporting, level: getCurrentLevel() };
  } catch {
    // Very early boot, before the privacy store is initialised: choose the
    // safer side — no buffering, plain console output.
    return { errorReporting: false, level: "standard" };
  }
}

export function reportError(
  error: Error,
  extra?: { componentStack?: string; context?: Record<string, unknown> },
): void {
  const { errorReporting, level } = readPolicySafely();

  // Console output is always emitted so devtools stay useful, but at
  // strict/paranoid we redact per the T-0a audit contract.
  const payload: ConsolePayload = {};
  if (level !== "strict" && level !== "paranoid") {
    payload.stack = error.stack;
    payload.componentStack = extra?.componentStack;
  }
  if (level !== "paranoid") {
    payload.context = extra?.context;
  }
  console.error("[PTN Error]", error.message, payload);

  if (!errorReporting) return;

  const report: ErrorReport = {
    message: error.message,
    stack: error.stack,
    componentStack: extra?.componentStack,
    context: extra?.context,
    timestamp: Date.now(),
    url: globalThis.location?.href ?? "",
    userAgent: globalThis.navigator?.userAgent ?? "",
  };

  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push(report);
}

export function getErrorBuffer(): readonly ErrorReport[] {
  return buffer;
}

export function clearErrorBuffer(): void {
  buffer.length = 0;
}

export function installGlobalHandlers(): void {
  globalThis.addEventListener("error", (event) => {
    reportError(event.error ?? new Error(event.message), {
      context: { type: "unhandled", filename: event.filename, lineno: event.lineno },
    });
  });

  globalThis.addEventListener("unhandledrejection", (event) => {
    const error = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason));
    reportError(error, { context: { type: "unhandledrejection" } });
  });
}

export function reportTelemetry(event: string, data: Record<string, unknown>): void {
  try {
    const { errorReporting } = readPolicySafely();
    if (!errorReporting) return;
    console.info("[telemetry]", { event, data, ts: Date.now() });
  } catch {
    /* never throw from telemetry */
  }
}
