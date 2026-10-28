import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import type { OutdoorInfluenceEstimate } from "../outdoor/influence";
import { OutdoorInfluenceOverlay2D, OutdoorInfluenceOverlay3D } from "./OutdoorInfluenceOverlay";

const estimate: OutdoorInfluenceEstimate = {
  metric: "temperature",
  availability: "ready",
  direction: "cooling",
  support: "medium",
  sensorCount: 3,
  outdoorValue: 2,
  indoorValue: 21,
  difference: -19,
  strength: .9,
  stale: false,
  windDriven: true,
  windwardEdge: "left",
  edges: [
    { edge: "top", strength: .56, windward: false },
    { edge: "right", strength: .34, windward: false },
    { edge: "bottom", strength: .56, windward: false },
    { edge: "left", strength: .9, windward: true },
  ],
};

describe("outdoor influence overlays", () => {
  it("renders restrained inward boundary cues with a complete text equivalent in 2D", () => {
    const floor = createDemoState().houses[0]!.floors[0]!;
    const view = render(<I18nProvider>
      <svg>
        <OutdoorInfluenceOverlay2D floor={floor} estimate={estimate} scale={10} units="metric" />
      </svg>
    </I18nProvider>);

    expect(screen.getByRole("img", { name: /cooling influence estimated.*outside 2.0 \u00b0C.*indoor average 21.0 \u00b0C/i })).not.toBeNull();
    expect(view.container.querySelectorAll(".outdoor-influence-arrow")).toHaveLength(4);
    expect(view.container.querySelector('[data-edge="left"]')?.getAttribute("data-windward")).toBe("true");
    expect(view.container.querySelector(".outdoor-influence-layer")?.getAttribute("data-direction")).toBe("cooling");
  });

  it("projects only the windward facade cue through the same estimate in 3D", () => {
    const house = createDemoState().houses[0]!;
    const view = render(<I18nProvider>
      <svg>
        <OutdoorInfluenceOverlay3D
          house={house}
          estimate={estimate}
          units="metric"
          project={(point) => ({ x: point.x * 10, y: point.y * 10 - point.z * 4, depth: point.y })}
        />
      </svg>
    </I18nProvider>);

    expect(screen.getByRole("img", { name: /estimated boundary influence only/i })).not.toBeNull();
    expect(view.container.querySelectorAll('.building-outdoor-influence [data-edge="left"]'))
      .toHaveLength(house.floors.length);
    expect(view.container.querySelectorAll(".building-outdoor-influence-face"))
      .toHaveLength(house.floors.length);
    expect(view.container.querySelector('.building-outdoor-influence [data-edge="right"]')).toBeNull();
  });
});
