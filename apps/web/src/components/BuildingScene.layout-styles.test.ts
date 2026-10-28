import { describe, expect, it } from "vitest";

import { cssRule, globalStyles } from "../test/styleSources";

describe("BuildingScene layout styles", () => {
  it("keeps the collapsed outdoor summary from offsetting the 3D viewport", () => {
    expect(cssRule(globalStyles, ".building-map-layout").get("position")).toBe("relative");
    const collapsed = cssRule(globalStyles, ".building-map-layout > .outdoor-context-card.collapsed");
    expect([collapsed.get("position"), collapsed.get("inset")]).toEqual(["absolute", "12px auto auto 12px"]);
  });
});
