import { describe, expect, it } from "vitest";

import { cssRule, globalStyles } from "../test/styleSources";

describe("IntegrationsPage layout styles", () => {
  it("fills the desktop setup navigation with its three primary tabs", () => {
    expect(cssRule(globalStyles, ".tabs.setup-workspace-tabs").get("grid-template-columns")).toBe("repeat(3, minmax(0, 1fr))");
  });

  it("separates the completed setup message from the progress heading", () => {
    expect(cssRule(globalStyles, ".setup-steps > .configured-note").get("margin-top")).toBe("18px");
  });
});
