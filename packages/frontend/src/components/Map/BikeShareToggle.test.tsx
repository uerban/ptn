import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { cyclocity, makeCity } from "../../test-helpers/bikeShareFixtures.ts";

// bikeShareStore pulls the GBFS client and Dexie helpers in at module load;
// neither is exercised here (enable/disable get stubbed per test), so both
// are mocked away to keep the component test hermetic.
vi.mock("../../db/index.ts", async () =>
  (await import("../../test-helpers/bikeShareFixtures.ts")).stubGbfsDb(),
);

import { BikeShareToggle } from "./BikeShareToggle.tsx";
import { useBikeShareStore } from "../../stores/bikeShareStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";

// Pristine store snapshot (real actions included) restored before each test
// so per-test action stubs never leak across tests.
const initialBikeShareState = useBikeShareStore.getState();

const vilnius = makeCity("vilnius", [cyclocity]);
const tricity = makeCity("tricity"); // no sharedMobility — chip must not show

beforeEach(() => {
  useBikeShareStore.setState(initialBikeShareState, true);
  useCityStore.setState({ activeCity: vilnius });
});

afterEach(() => {
  cleanup();
});

describe("BikeShareToggle", () => {
  test("renders nothing for a city without sharedMobility config", () => {
    useCityStore.setState({ activeCity: tricity });
    const { container } = render(<BikeShareToggle />);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing for a city with an empty sharedMobility list", () => {
    useCityStore.setState({ activeCity: makeCity("empty", []) });
    const { container } = render(<BikeShareToggle />);
    expect(container.innerHTML).toBe("");
  });

  test("renders off-by-default for a configured city (no auto-enable)", () => {
    render(<BikeShareToggle />);
    const btn = screen.getByRole("button", { name: /bike share/i });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    // Rendering the chip must never trigger a fetch on its own — the store
    // stays untouched until the user taps (opt-in).
    expect(useBikeShareStore.getState().enabled).toBe(false);
    expect(useBikeShareStore.getState().status).toBe("idle");
  });

  test("tap when off calls bikeShareStore.enable with the active city", () => {
    const enable = vi.fn(async () => {});
    useBikeShareStore.setState({ enable });
    render(<BikeShareToggle />);
    fireEvent.click(screen.getByRole("button", { name: /bike share/i }));
    expect(enable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledWith(vilnius);
  });

  test("pressed state reflects enabled and tap when on calls disable", () => {
    const disable = vi.fn();
    useBikeShareStore.setState({ enabled: true, disable });
    render(<BikeShareToggle />);
    const btn = screen.getByRole("button", { name: /bike share/i });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(disable).toHaveBeenCalledTimes(1);
  });
});
