import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

const OFFER = "Search addresses on the server";

const PHOTON_RESPONSE = {
  features: [
    {
      geometry: { type: "Point", coordinates: [25.2797, 54.6872] },
      properties: { name: "Offer Test Street 9", city: "Vilnius", country: "Lithuania" },
    },
  ],
};

test("address search on the server waits for a deliberate Allow @mock-api", async ({ page }) => {
  await mockApi(page);
  await page.route("**/poi/manifest.json", (route) => route.fulfill({ status: 404, body: "" }));
  // A deployment that ships its own address search server.
  await page.route("**/geocoder-config.json", (route) =>
    route.fulfill({
      json: { kind: "self-hosted", endpoint: "/offer-geocoder", flavor: "photon", multiTenant: false },
    }),
  );
  const geocoderQueries: string[] = [];
  await page.route("**/offer-geocoder/**", (route) => {
    geocoderQueries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({ json: PHOTON_RESPONSE });
  });

  await page.goto("/search");
  const destination = page.getByRole("searchbox").last();
  await destination.fill("Offer Test");

  const offer = page.getByRole("button", { name: OFFER });
  await expect(offer).toBeVisible();
  // The search settled on the device; nothing went to the address server.
  await expect(page.getByText("No matching place suggestions")).toBeVisible();
  expect(geocoderQueries).toEqual([]);

  await offer.click();
  const disclosure = page.getByTestId("flow-disclosure");
  await expect(disclosure).toHaveAttribute("data-flow", "operator.place-search");
  expect(geocoderQueries).toEqual([]);
  await disclosure.getByRole("button", { name: OFFER }).click();

  await expect(page.getByRole("option", { name: /Offer Test Street 9/ })).toBeVisible();
  expect(geocoderQueries).toContain("Offer Test");
  await expect(page.getByRole("button", { name: OFFER })).toHaveCount(0);
});
