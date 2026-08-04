import type { HeatPumpState } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { estimateHeatPumpInfluence } from "./heatPumpImpact";

const state: HeatPumpState = {
  connectionId: "gree-580d0db83a95",
  houseId: "house-main",
  equipmentId: "heat-pump-580d0db83a95",
  deviceId: "580D0DB83A95",
  name: "AC3a95",
  brand: "Wilfa",
  model: "10001",
  transport: "ewpe-cloud",
  floorId: "floor-ground",
  roomId: "living",
  x: 3,
  y: 2,
  z: 2.3,
  observedAt: "2026-08-03T17:20:00.000Z",
  receivedAt: "2026-08-03T17:20:01.000Z",
  available: true,
  power: true,
  selectedMode: "cool",
  targetTemperatureC: 20,
  currentTemperatureC: 20,
  currentTemperatureSource: "reported",
  fanSpeed: "auto",
  horizontalSwing: "middle",
  verticalSwing: "full",
  quiet: false,
  turbo: false,
  xfan: true,
  compressorFrequencyHz: 12,
  diagnostics: { wifiStatus: 1 },
  activity: "unknown",
  activityEvidence: "unavailable",
};

describe("heat-pump influence estimate", () => {
  it("uses positive compressor frequency as bounded evidence, not delivered heat", () => {
    expect(estimateHeatPumpInfluence(state)).toEqual({
      kind: "cooling",
      intensity: .25,
      compressorEvidence: true,
      visible: true,
    });
  });

  it("labels selected heating/cooling as uncertain when frequency is unavailable", () => {
    expect(estimateHeatPumpInfluence({ ...state, selectedMode: "heat", compressorFrequencyHz: null })).toEqual({
      kind: "heating",
      intensity: .18,
      compressorEvidence: false,
      visible: true,
    });
  });

  it("does not show influence for unavailable or powered-off units", () => {
    expect(estimateHeatPumpInfluence({ ...state, available: false })).toMatchObject({
      kind: "unknown", visible: false, compressorEvidence: false,
    });
    expect(estimateHeatPumpInfluence({ ...state, power: false })).toMatchObject({
      kind: "off", visible: false, compressorEvidence: false,
    });
  });
});
