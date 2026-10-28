import { describe, expect, it } from "vitest";

import { cssRule, globalStyles } from "../test/styleSources";

describe("TwinDashboard Live View responsive styles", () => {
  it("keeps optional controls in a bounded desktop disclosure", () => {
    const menu = cssRule(globalStyles, ".twin-view-options-menu");
    expect([menu.get("position"), menu.get("width")]).toEqual(["absolute", "min(340px, calc(100vw - 32px))"]);
    expect(cssRule(globalStyles, ".twin-option-list button").get("grid-template-columns")).toBe("auto minmax(0, 1fr) 18px");
  });

  it("turns the menu into a full-width inline disclosure at phone widths", () => {
    const phone = "(max-width: 680px)";
    expect(cssRule(globalStyles, ".toolbar-navigation", phone).get("grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
    expect(cssRule(globalStyles, ".toolbar-view-controls", phone).get("grid-column")).toBe("1 / -1");
    for (const control of [".twin-view-options", ".twin-close-live-view"]) {
      const rule = cssRule(globalStyles, control, phone);
      expect([rule.get("width"), rule.get("grid-column")]).toEqual(["100%", "1 / -1"]);
    }
    const menu = cssRule(globalStyles, ".twin-view-options-menu", phone);
    expect([menu.get("position"), menu.get("width"), menu.get("min-width")]).toEqual(["static", "100%", "0"]);
  });

  it("keeps every Live View navigation target touch-sized", () => {
    expect(cssRule(globalStyles,
      ".main-content .twin-toolbar :is(select, .toolbar-navigation button, .toolbar-edit-actions button, .twin-view-options summary)",
    ).get("min-height")).toBe("44px");
  });
});
