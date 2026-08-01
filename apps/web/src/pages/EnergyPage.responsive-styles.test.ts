import { describe, expect, it } from "vitest";

import energyStyles from "./EnergyPage.css?raw";

describe("EnergyPage responsive styles", () => {
  it("stacks and wraps optimizer heading badges on narrow screens", () => {
    expect(energyStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.energy-optimizer > summary\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/,
    );
    expect(energyStyles).toMatch(
      /\.energy-optimizer-badges\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*min-width:\s*0[^}]*justify-content:\s*flex-start/,
    );
    expect(energyStyles).toMatch(
      /\.energy-optimizer > summary \.status-badge\s*\{[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/,
    );
  });
});
