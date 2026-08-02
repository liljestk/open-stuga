import { describe, expect, it } from "vitest";

import buildingStyles from "../styles/global/05-outdoor-context-card-small.css?raw";

describe("BuildingScene layout styles", () => {
  it("keeps the collapsed outdoor summary from offsetting the 3D viewport", () => {
    expect(buildingStyles).toMatch(
      /\.floor-plan-layout,\s*\.building-map-layout\s*\{[^}]*position:\s*relative/,
    );
    expect(buildingStyles).toMatch(
      /\.building-map-layout > \.outdoor-context-card\.collapsed\s*\{[^}]*position:\s*absolute[^}]*inset:\s*12px auto auto 12px/,
    );
  });
});
