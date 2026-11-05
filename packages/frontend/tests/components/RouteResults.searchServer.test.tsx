import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";

vi.mock("../../src/stores/privacyStore.ts", () => ({
  usePolicy: vi.fn(() => ({ errorReporting: false, savesEncryption: "off" })),
  registerLevelChangeListener: vi.fn(),
}));
vi.mock("../../src/buildInfo.ts", () => ({
  buildInfo: { version: "test-version", commit: "abc", builtAt: "2026-01-01" },
}));

describe("RouteResults remote action threading", () => {
  it("offers 'Search on the server' in the engine-error branch", () => {
    const onSearchOnServer = vi.fn();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={vi.fn()} loading={false}
          engineError="boom" engineFailureKind="no-wasm" remoteSearch={{ onSearchOnServer }} />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByTestId("engine-failure-search-server"));
    expect(onSearchOnServer).toHaveBeenCalledOnce();
  });
  // The empty-results "try the server" nicety is driven by the SEPARATE
  // `emptyRemoteSearch` prop (availability-gated upstream), NOT `remoteSearch`
  // (the engine-failure recovery affordance, which is privacy-gated only).
  it("offers 'Search on the server' in the empty-results branch", () => {
    const onSearchOnServer = vi.fn();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={vi.fn()} loading={false}
          emptyRemoteSearch={{ onSearchOnServer }} />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByTestId("empty-search-server"));
    expect(onSearchOnServer).toHaveBeenCalledOnce();
  });
  it("server-empty state shows the distinct copy and NO remote button", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[]}
          onSelect={() => {}}
          serverEmpty
          emptyRemoteSearch={{ onSearchOnServer: () => {} }}
        />
      </BrowserRouter>
    );
    expect(screen.getByTestId("server-no-route")).toHaveTextContent("The server found no route for this trip.");
    expect(screen.queryByTestId("empty-search-server")).not.toBeInTheDocument();
  });
  it("non-server-empty empty state keeps the existing remote button", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[]}
          onSelect={() => {}}
          emptyRemoteSearch={{ onSearchOnServer: () => {} }}
        />
      </BrowserRouter>
    );
    expect(screen.queryByTestId("server-no-route")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-search-server")).toBeInTheDocument();
  });
  // The empty-state branch reads ONLY `emptyRemoteSearch` — passing the recovery
  // `remoteSearch` prop alone must NOT surface the empty-state button (guards the
  // prop split: the two affordances are independent).
  it("empty state does NOT show the button when only `remoteSearch` is wired", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[]}
          onSelect={() => {}}
          remoteSearch={{ onSearchOnServer: () => {} }}
        />
      </BrowserRouter>
    );
    expect(screen.queryByTestId("empty-search-server")).not.toBeInTheDocument();
  });
});
