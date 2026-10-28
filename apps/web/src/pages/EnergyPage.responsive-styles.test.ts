import { describe, expect, it } from "vitest";

import energyStyles from "./EnergyPage.css?raw";
import { cssRule } from "../test/styleSources";

describe("EnergyPage responsive styles", () => {
  it("stacks and wraps optimizer heading badges on narrow screens", () => {
    expect(cssRule(energyStyles, ".energy-optimizer > summary", "(max-width: 680px)").get("grid-template-columns"))
      .toBe("minmax(0, 1fr) auto");
    const badges = cssRule(energyStyles, ".energy-optimizer-badges", "(max-width: 680px)");
    expect([badges.get("grid-column"), badges.get("min-width"), badges.get("justify-content")]).toEqual(["1 / -1", "0", "flex-start"]);
    const badge = cssRule(energyStyles, ".energy-optimizer > summary .status-badge", "(max-width: 680px)");
    expect([badge.get("max-width"), badge.get("white-space"), badge.get("overflow-wrap")]).toEqual(["100%", "normal", "anywhere"]);
  });
});
