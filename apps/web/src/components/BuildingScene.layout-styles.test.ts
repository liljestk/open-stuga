import { describe, expect, it } from "vitest";

import { cssRule, globalStyles } from "../test/styleSources";

describe("BuildingScene layout styles", () => {
  it("keeps the collapsed outdoor summary from offsetting the 3D viewport", () => {
    expect(cssRule(globalStyles, ".building-map-layout").get("position")).toBe("relative");
    const collapsed = cssRule(globalStyles, ".building-map-layout > .outdoor-context-card.collapsed");
    expect([collapsed.get("position"), collapsed.get("inset")]).toEqual(["absolute", "12px auto auto 12px"]);
  });

  it("keeps the collapsed outdoor summary in the flow above a stacked 3D view, off the shell's chips", () => {
    const stacked = "@container building-scene (max-width: 760px)";
    expect(cssRule(globalStyles, ".building-map-layout", stacked).get("flex-direction")).toBe("column");
    const collapsed = cssRule(globalStyles, ".building-map-layout > .outdoor-context-card.collapsed", stacked);
    expect([collapsed.get("position"), collapsed.get("inset")]).toEqual(["relative", "auto"]);
  });

  it("gives the shell title chip the action colour pair so its label reads in both themes", () => {
    expect(cssRule(globalStyles, ".building-shell-title rect").get("fill")).toBe("var(--action)");
    expect(cssRule(globalStyles, ".building-shell-title .outdoor-shell-chip-label").get("fill")).toBe("var(--on-action)");
    expect(cssRule(globalStyles, ".building-shell-title rect", "(prefers-color-scheme: dark)").get("fill")).toBe("var(--action)");
  });
});
