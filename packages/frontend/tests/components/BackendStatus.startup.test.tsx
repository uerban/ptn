import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BackendStatus } from "../../src/components/Layout/BackendStatus.tsx";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { CITIES } from "../../src/config/cities.ts";

const VILNIUS = CITIES.find((c) => c.id === "vilnius")!; // not in STALE_FEED_THRESHOLD_BY_CITY → no stale banner to confound the "ok" case

function mockFetch(ok: boolean, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(body) }));
}

describe("BackendStatus startup banner", () => {
  beforeEach(() => useCityStore.getState().setActiveCity(VILNIUS));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders the loading banner when /health/ready is not ok (503)", async () => {
    mockFetch(false);
    const { findByRole } = render(<BackendStatus />);
    const banner = await findByRole("status");
    expect(banner).toHaveTextContent(/Transit data is loading/i);
  });

  it("renders nothing when /health/ready is ok and feed is fresh", async () => {
    mockFetch(true, { status: "ready", feedAgeSeconds: 10 });
    const { container } = render(<BackendStatus />);
    await waitFor(() => expect(container.querySelector("[role='status']")).toBeNull());
  });
});

// A server that has been unreachable for minutes is an outage, not a warm-up.
// The startup copy ("…will appear shortly") told users to keep waiting while
// the map sat empty — the field report that prompted this file's second half.
describe("BackendStatus sustained-outage banner", () => {
  beforeEach(() => {
    useCityStore.getState().setActiveCity(VILNIUS);
    vi.useFakeTimers();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("keeps the startup copy for a single failed probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { container } = render(<BackendStatus />);
    await tick(0);

    const banner = container.querySelector("[role='status']");
    expect(banner).toHaveTextContent(/Transit data is loading/i);
  });

  it("switches to the outage copy once probes keep failing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { container } = render(<BackendStatus />);
    await tick(0);
    await tick(30_000); // second poll, still unreachable

    const banner = container.querySelector("[role='status']");
    expect(banner).toHaveTextContent(/unreachable/i);
    expect(banner).toHaveTextContent(/out of date/i);
  });

  it("does not use the outage copy for a reachable-but-not-ready backend", async () => {
    mockFetch(false); // pt-serve self-reload: answering, 503
    const { container } = render(<BackendStatus />);
    await tick(0);
    await tick(30_000);
    await tick(30_000);

    const banner = container.querySelector("[role='status']");
    expect(banner).toHaveTextContent(/Transit data is loading/i);
    expect(banner).not.toHaveTextContent(/unreachable/i);
  });

  it.each([502, 504])("treats repeated HTTP %s as a gateway outage", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
    const { container } = render(<BackendStatus />);
    await tick(0);
    expect(container.querySelector("[role='status']")).toHaveTextContent(/Transit data is loading/i);
    await tick(30_000);
    expect(container.querySelector("[role='status']")).toHaveTextContent(/unreachable/i);
  });

  it("counts mixed network and gateway failures toward the same outage", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ ok: false, status: 502 }));
    const { container } = render(<BackendStatus />);
    await tick(0);
    await tick(30_000);
    expect(container.querySelector("[role='status']")).toHaveTextContent(/unreachable/i);
  });

  it("clears a gateway outage when readiness returns", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<BackendStatus />);
    await tick(0);
    await tick(30_000);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "ready" }) });
    await tick(30_000);
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("starts a new city's failure count from zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const { container } = render(<BackendStatus />);
    await tick(0);
    await tick(30_000);
    expect(container.querySelector("[role='status']")).toHaveTextContent(/unreachable/i);
    await act(async () => { useCityStore.getState().setActiveCity(CITIES.find((c) => c.id === "krakow")!); });
    await tick(0);
    expect(container.querySelector("[role='status']")).toHaveTextContent(/Transit data is loading/i);
  });

  it("clears the banner when the server comes back", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<BackendStatus />);
    await tick(0);
    await tick(30_000);
    expect(container.querySelector("[role='status']")).toHaveTextContent(/unreachable/i);

    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: "ready", feedAgeSeconds: 10 }) });
    await tick(30_000);

    expect(container.querySelector("[role='status']")).toBeNull();
  });
});
