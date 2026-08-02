import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { masonryRowSpan, SetupProviderGrid } from "./SetupProviderGrid";

describe("SetupProviderGrid", () => {
  it("calculates independent row spans with a stable visual gap", () => {
    expect(masonryRowSpan(100, 1, 1)).toBe(58);
    expect(masonryRowSpan(1_200, 1, 1)).toBe(608);
    expect(masonryRowSpan(0, 1, 1)).toBeNull();
    expect(masonryRowSpan(100, Number.NaN, 16)).toBeNull();
  });

  it("preserves semantic provider grouping and DOM order", () => {
    render(<SetupProviderGrid label="Connection methods">
      <section>Tuya</section>
      <section>TP-Link</section>
      <section>Home Assistant</section>
    </SetupProviderGrid>);

    const group = screen.getByRole("group", { name: "Connection methods" });
    expect(Array.from(group.children).map((child) => child.textContent)).toEqual([
      "Tuya",
      "TP-Link",
      "Home Assistant",
    ]);
  });
});
