import { describe, expect, it } from "vitest";

import { cssRule, globalStyles } from "../test/styleSources";

const phones = "(max-width: 680px)";
const stacked = "@container floor-plan (max-width: 760px)";
const collapsedOnPlan = ".floor-plan-layout > .outdoor-context-card.collapsed";

function pixels(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value ?? "");
  if (!match) throw new Error(`Expected a pixel length, got ${value}`);
  return Number(match[1]);
}

describe("OutdoorConditionsBadge layout styles", () => {
  it("starts the collapsed card on the 2D plan beside the zoom controls instead of over zoom-in", () => {
    const zoom = cssRule(globalStyles, ".plan-zoom-controls");
    const zoomButton = cssRule(globalStyles, ".plan-zoom-controls button");
    const zoomRight = pixels(zoom.get("left")) + pixels(zoomButton.get("width")) + 2 * pixels(zoom.get("border")?.split(" ")[0]);
    const [top, right, bottom, left] = cssRule(globalStyles, collapsedOnPlan).get("inset")!.split(" ");

    expect(pixels(left)).toBeGreaterThan(zoomRight);
    expect([pixels(top), right, bottom]).toEqual([pixels(zoom.get("top")), "auto", "auto"]);
  });

  it("keeps the collapsed card in the flow above a stacked plan, off the zoom controls and the shell's chips", () => {
    expect(cssRule(globalStyles, ".floor-plan-layout", stacked).get("flex-direction")).toBe("column");
    const collapsed = cssRule(globalStyles, collapsedOnPlan, stacked);
    expect([collapsed.get("position"), collapsed.get("inset")]).toEqual(["relative", "auto"]);
    // Phones (≤ 680px) always get the stacked plan: the floor-plan container is never wider than the page.
    expect(pixels(/max-width: (\d+px)/u.exec(stacked)?.[1])).toBeGreaterThanOrEqual(pixels(/max-width: (\d+px)/u.exec(phones)?.[1]));
    // No phone rule may float it back over the plan.
    expect(() => cssRule(globalStyles, collapsedOnPlan, phones)).toThrow();
  });

  it("wraps condition tiles from their content width instead of cutting them to fixed thirds", () => {
    const values = cssRule(globalStyles, ".outdoor-context-values");
    expect([values.get("display"), values.get("flex-wrap"), values.get("grid-template-columns")]).toEqual(["flex", "wrap", undefined]);
    expect(cssRule(globalStyles, ".outdoor-context-values > span").get("flex")).toBe("1 1 auto");
  });
});
