import { describe, expect, it } from "vitest";
import type { House, OutdoorConditions } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { createOutdoorBoundaryContextFromConditions } from "./context";
import { createOutdoorWindFlowGeometry } from "./windFlow";

function windContext(windDirectionDegrees: number | null, windSpeedMps: number, stale = false) {
  const house: House = { ...createDemoState().houses[0]!, orientationDegrees: 0 };
  const conditions: OutdoorConditions = {
    timestamp: "2026-07-31T07:00:00.000Z",
    temperatureC: 12,
    relativeHumidityPercent: 78,
    windSpeedMps,
    ...(windDirectionDegrees === null ? {} : { windDirectionDegrees }),
  };
  return createOutdoorBoundaryContextFromConditions(house, conditions, stale);
}

describe("outdoor wind flow geometry", () => {
  it("places southwest wind on the southwest part of an oblong plan and follows the shell both ways", () => {
    const geometry = createOutdoorWindFlowGeometry(windContext(225, 4), 1000, 400, 64)!;

    expect(geometry.source.x).toBeLessThan(500);
    expect(geometry.source.y).toBeGreaterThan(200);
    expect(geometry.sourceEdge).toBe("bottom");
    expect(geometry.windwardPath).toMatch(/^M.*L/);
    expect(geometry.incomingPaths).toHaveLength(3);
    expect(geometry.bypassPaths).toHaveLength(2);
    expect(geometry.particleCount).toBe(2);
    expect(geometry.motionSupported).toBe(true);
  });

  it("keeps direction geometry but suppresses motion for stale or calm observations", () => {
    const stale = createOutdoorWindFlowGeometry(windContext(225, 4, true), 1000, 400, 64)!;
    const calm = createOutdoorWindFlowGeometry(windContext(225, .1), 1000, 400, 64)!;

    expect(stale.windwardPath).not.toBe("");
    expect(stale.motionSupported).toBe(false);
    expect(calm.windwardPath).not.toBe("");
    expect(calm.particleCount).toBe(0);
    expect(calm.motionSupported).toBe(false);
  });

  it("uses conservative density bands and requires a plan-relative bearing", () => {
    expect(createOutdoorWindFlowGeometry(windContext(225, 2), 1000, 400, 64)?.particleCount).toBe(1);
    expect(createOutdoorWindFlowGeometry(windContext(225, 9), 1000, 400, 64)?.particleCount).toBe(3);
    expect(createOutdoorWindFlowGeometry(windContext(null, 9), 1000, 400, 64)).toBeNull();
  });
});
