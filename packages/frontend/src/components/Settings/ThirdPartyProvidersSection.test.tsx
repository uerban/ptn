import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ThirdPartyProvidersSection } from "./ThirdPartyProvidersSection.tsx";
import { usePrivacyStore, getPolicy } from "../../stores/privacyStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { getNetworkDecision } from "../../privacy/canUse.ts";
import { resetFlows } from "../../test-helpers/networkDecisions.ts";

afterEach(() => cleanup());

beforeEach(() => {
  usePrivacyStore.getState().reset();
  resetFlows();
  useSettingsStore.setState({
    thirdPartyProvider: "nominatim",
    thirdPartyApiKeys: {},
  });
});

describe("ThirdPartyProvidersSection", () => {
  test("renders a radio per allowlist provider", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    for (const id of ["mapbox", "nominatim", "photon"]) {
      const radio = container.querySelector(
        `input[name="third-party-provider"][value="${id}"]`,
      );
      expect(radio).not.toBeNull();
    }
  });

  test("shows API-key input only for providers with apiKeyFormat", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const apiInputs = container.querySelectorAll(
      'input[type="password"][data-provider]',
    );
    expect(apiInputs.length).toBe(1);
    expect((apiInputs[0] as HTMLInputElement).dataset.provider).toBe("mapbox");
  });

  test("visible at baseline level", () => {
    usePrivacyStore.getState().setLevel("baseline");
    const { container } = render(<ThirdPartyProvidersSection />);
    const radios = container.querySelectorAll(
      'input[name="third-party-provider"]',
    );
    expect(radios.length).toBe(3);
    radios.forEach((r) =>
      expect((r as HTMLInputElement).disabled).toBe(false),
    );
  });

  test("visible at standard level", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const radios = container.querySelectorAll(
      'input[name="third-party-provider"]',
    );
    expect(radios.length).toBe(3);
    radios.forEach((r) =>
      expect((r as HTMLInputElement).disabled).toBe(false),
    );
  });

  test.each(["hardened", "strict", "paranoid"] as const)(
    "stays configurable at %s: the level does not decide network use",
    async (level) => {
      await usePrivacyStore.getState().setLevel(level);
      const { container } = render(<ThirdPartyProvidersSection />);
      expect(
        container.querySelectorAll('input[name="third-party-provider"]').length,
      ).toBe(3);
    },
  );

  test("selecting a provider updates the store", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const photon = container.querySelector(
      'input[name="third-party-provider"][value="photon"]',
    ) as HTMLInputElement;
    fireEvent.click(photon);
    expect(useSettingsStore.getState().thirdPartyProvider).toBe("photon");
  });

  test("selecting a provider does not allow it", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    fireEvent.click(
      container.querySelector(
        'input[name="third-party-provider"][value="photon"]',
      ) as HTMLInputElement,
    );
    expect(getNetworkDecision("external.place-search", "photon").value).toBe("unset");
  });

  test("API key input updates the store", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const apiInput = container.querySelector(
      'input[type="password"][data-provider="mapbox"]',
    ) as HTMLInputElement;
    fireEvent.change(apiInput, { target: { value: "pk.test123" } });
    expect(useSettingsStore.getState().thirdPartyApiKeys.mapbox).toBe(
      "pk.test123",
    );
  });
});

describe("inline threat-model disclosure", () => {
  test("renders disclosure text adjacent to the toggle", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const disclosure = container.querySelector(
      '[data-testid="third-party-disclosure"]',
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure!.textContent).toContain("Enabling this sends coordinates");
    expect(disclosure!.textContent).toContain("NOT mitigated");
  });

  test("disclosure dynamically inserts gridMeters", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const disclosure = container.querySelector(
      '[data-testid="third-party-disclosure"]',
    )!;
    const gridMeters = getPolicy().m10CoarsenGridDefaultMeters;
    expect(disclosure.textContent).toContain(`grid-snapped to ${gridMeters}m`);
  });

  test("disclosure dynamically inserts selected provider name", () => {
    useSettingsStore.setState({ thirdPartyProvider: "photon" });
    const { container } = render(<ThirdPartyProvidersSection />);
    const disclosure = container.querySelector(
      '[data-testid="third-party-disclosure"]',
    )!;
    expect(disclosure.textContent).toContain("Photon (Komoot)");
  });

  test("disclosure updates when provider changes", () => {
    useSettingsStore.setState({ thirdPartyProvider: "mapbox" });
    const { container } = render(<ThirdPartyProvidersSection />);
    const disclosure = container.querySelector(
      '[data-testid="third-party-disclosure"]',
    )!;
    expect(disclosure.textContent).toContain("Mapbox");
    expect(disclosure.textContent).not.toContain("Nominatim");
  });

  test("disclosure is shown at strict too", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    const { container } = render(<ThirdPartyProvidersSection />);
    expect(
      container.querySelector('[data-testid="third-party-disclosure"]'),
    ).not.toBeNull();
  });
});

describe("grid-size slider", () => {
  test("slider min = policy.m10CoarsenGridFloorMeters at standard", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const slider = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(slider).not.toBeNull();
    expect(Number(slider.min)).toBe(
      getPolicy().m10CoarsenGridFloorMeters,
    );
  });

  test("slider min = policy floor at baseline", async () => {
    await usePrivacyStore.getState().setLevel("baseline");
    const { container } = render(<ThirdPartyProvidersSection />);
    const slider = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(Number(slider.min)).toBe(0);
  });

  test("slider min follows the stricter floor at hardened", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    const { container } = render(<ThirdPartyProvidersSection />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(Number(slider.min)).toBe(getPolicy().m10CoarsenGridFloorMeters);
  });

  test("default value = policy.m10CoarsenGridDefaultMeters", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const slider = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(Number(slider.value)).toBe(
      getPolicy().m10CoarsenGridDefaultMeters,
    );
  });

  test("dragging below floor is impossible (min attribute enforced)", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const slider = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    const floor = getPolicy().m10CoarsenGridFloorMeters;
    expect(Number(slider.min)).toBe(floor);
  });

  test("changing slider persists override to privacy store", () => {
    const { container } = render(<ThirdPartyProvidersSection />);
    const slider = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "500" } });
    expect(
      usePrivacyStore.getState().overrides.m10CoarsenGridDefaultMeters,
    ).toBe(500);
  });

  test("slider rendered at strict too", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    const { container } = render(<ThirdPartyProvidersSection />);
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });
});
