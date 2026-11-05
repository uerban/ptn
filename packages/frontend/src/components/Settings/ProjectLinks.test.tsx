import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectLinks } from "./ProjectLinks.tsx";

afterEach(cleanup);

describe("ProjectLinks", () => {
  test("links to the public source and license notices", () => {
    render(<ProjectLinks />);

    expect(screen.getByRole("navigation", { name: "Project links" })).toBeTruthy();

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/uerban/ptn",
      "https://github.com/uerban/ptn/blob/main/LICENSE",
      "https://github.com/uerban/ptn/blob/main/THIRD_PARTY_NOTICES.md",
    ]);

    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
});
