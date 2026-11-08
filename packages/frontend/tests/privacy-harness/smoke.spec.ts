import { test, expect } from "@playwright/test";
import { mockApi } from "../../e2e/helpers/mock-api";
import { bootAtPrivacyLevel } from "./bootAtLevel";
import {
  installNetworkRecorder,
  classifyRequest,
  assertNetworkPattern,
} from "./assertNetworkPattern";

// Smoke test (T-X-4a step 4): proves both harness primitives wire cleanly
// against the existing app at Standard. Per-level golden snapshots and the
// CI step land in T-X-4b / T-X-4c.
test.describe("privacy harness — smoke @mock-api", () => {
  test("bootAtPrivacyLevel + recorder run cleanly at Standard", async ({
    page,
  }) => {
    await bootAtPrivacyLevel(page, "standard");
    await mockApi(page);
    const recorder = installNetworkRecorder(page);

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // Confirm the seeded privacyStore actually hydrated at the requested
    // level — this is the load-bearing invariant of bootAtPrivacyLevel.
    const persisted = await page.evaluate(() =>
      localStorage.getItem("ptn-privacy"),
    );
    expect(persisted).toBeTruthy();
    const parsed = JSON.parse(persisted!) as { state?: { level?: string } };
    expect(parsed.state?.level).toBe("standard");

    // Recorder picks up at least the index document. Anything beyond that
    // is environmental noise we don't assert on — the smoke test only
    // verifies the harness wires up; it isn't a behavioral oracle.
    expect(recorder.requests.length).toBeGreaterThan(0);

    // assertNetworkPattern with empty expectations is a no-op — proves the
    // assertion API is callable without false failures.
    assertNetworkPattern(recorder, []);
    recorder.stop();
  });

  test("classifyRequest buckets known URL shapes correctly", () => {
    expect(classifyRequest("https://x.example/api/gdansk/stops/nearby?lat=1")).toBe(
      "stops-nearby",
    );
    expect(classifyRequest("https://x.example/api/gdansk/stops/all")).toBe(
      "stops-all",
    );
    expect(
      classifyRequest("https://x.example/api/gdansk/departures?stopId=s1"),
    ).toBe("departures");
    expect(classifyRequest("https://x.example/api/vilnius/raptor-bundle")).toBe(
      "catalog-bundle",
    );
    expect(classifyRequest("https://x.example/api/vilnius/alerts")).toBe(
      "service-alerts",
    );
    expect(
      classifyRequest("https://nominatim.example/reverse?lat=54.6&lon=18.6"),
    ).toBe("reverse-geocode");
    expect(
      classifyRequest("https://nominatim.example/search?q=Vilnius"),
    ).toBe("forward-geocode");
    expect(classifyRequest("https://tiles.example/12/2345/1456.pbf")).toBe(
      "tile",
    );
    // Same-origin app assets, kept out of the tile bucket so a golden does not
    // read as "this preset fetches map tiles".
    expect(
      classifyRequest("https://x.example/glyphs/Open%20Sans%20Regular/0-255.pbf"),
    ).toBe("glyphs");
    expect(
      classifyRequest("https://x.example/micromap/vilnius.micromap.br"),
    ).toBe("micromap");
    // The app's own source paths share the /micromap/ segment under the dev
    // server; only the artifact counts.
    expect(
      classifyRequest("http://localhost:5173/src/map/micromap/types.ts"),
    ).toBe("other");
    expect(
      classifyRequest("https://example.test/some/random/thing.json"),
    ).toBe("other");
  });
});
