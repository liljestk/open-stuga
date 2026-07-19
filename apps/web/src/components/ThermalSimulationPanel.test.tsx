import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThermalSimulationResult } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";

const mocks = vi.hoisted(() => ({
  result: null as ThermalSimulationResult | null,
  run: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../useThermalSimulation", () => ({
  useThermalSimulation: () => ({ result: mocks.result, loading: false, error: false, run: mocks.run, reset: mocks.reset }),
}));

import {
  formatSignedTemperatureDelta,
  ThermalSimulationPanel,
  temperatureDeltaForDisplay,
  temperatureFromDisplay,
} from "./ThermalSimulationPanel";

function result(status: "ready" | "provisional" | "insufficient-data" = "provisional"): ThermalSimulationResult {
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    systemVersion: "0.3.0",
    houseId: "house-main",
    sensorId: "sensor-01",
    roomLabel: "Living room",
    from: "2026-07-13T10:00:00.000Z",
    to: "2026-07-14T10:00:00.000Z",
    horizonHours: 2,
    scenarioOutdoorTemperatureC: -5,
    scenarioAnchorTimestamp: "2026-07-14T10:00:00.000Z",
    calibration: {
      status,
      model: status === "insufficient-data" ? null : {
        method: "first-order-lumped-v1",
        version: "1.0.0",
        scope: { houseId: "house-main", sensorIds: ["sensor-01"] },
        trainedFrom: "2026-07-13T10:00:00.000Z",
        trainedTo: "2026-07-14T10:00:00.000Z",
        parameters: { timeConstantHours: 18, effectiveEquilibriumLiftC: 16 },
        applicability: { indoorMinC: 19, indoorMaxC: 22, outdoorMinC: -8, outdoorMaxC: 14, maxHorizonHours: 48 },
        sensitivity: { timeConstantLowHours: 14, timeConstantHighHours: 25, liftLowC: 14, liftHighC: 18 },
      },
      quality: {
        indoorSamples: 100,
        outdoorSamples: 98,
        alignedSamples: 96,
        transitionsUsed: 95,
        durationHours: 24,
        indoorRangeC: 3,
        outdoorRangeC: 22,
        validationMaeC: status === "insufficient-data" ? null : 0.22,
        validationRmseC: status === "insufficient-data" ? null : 0.31,
        validationBiasC: status === "insufficient-data" ? null : -0.04,
        persistenceMaeC: status === "insufficient-data" ? null : 0.45,
        residualP90C: status === "insufficient-data" ? null : 0.5,
      },
      warnings: status === "insufficient-data" ? ["INSUFFICIENT_OVERLAP"] : ["SHORT_CALIBRATION_WINDOW"],
      assumptions: [],
    },
    points: status === "insufficient-data" ? [] : [
      { timestamp: "2026-07-14T08:00:00.000Z", phase: "fit", outdoorTemperatureC: 8, observedTemperatureC: 21, simulatedTemperatureC: 20.6, residualC: 0.4, lowC: 20.1, highC: 21.1 },
      { timestamp: "2026-07-14T09:00:00.000Z", phase: "fit", outdoorTemperatureC: 7, observedTemperatureC: 20.5, simulatedTemperatureC: 20.7, residualC: -0.2, lowC: 20.2, highC: 21.2 },
      { timestamp: "2026-07-14T10:00:00.000Z", phase: "scenario", outdoorTemperatureC: -5, observedTemperatureC: null, simulatedTemperatureC: 19.8, residualC: null, lowC: 19, highC: 20.6 },
    ],
  };
}

describe("ThermalSimulationPanel", () => {
  beforeEach(() => {
    mocks.result = null;
    mocks.run.mockClear();
    mocks.reset.mockClear();
  });

  it("renders observed, simulated, model-band, and signed residual layers separately", () => {
    mocks.result = result();
    const state = createDemoState();
    render(<I18nProvider><ThermalSimulationPanel houseId="house-main" sensor={state.sensors[0]!} range="24h" units="metric" timeZone="Europe/Helsinki" /></I18nProvider>);

    expect(screen.getAllByText("Observed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Empirical model band").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Residual (observed − simulated)").length).toBeGreaterThan(0);
    const chart = screen.getByRole("img", { name: /separate signed residual plot/i });
    expect(chart.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/Simulated: 19\.8 °C/i, { selector: ".sr-only" })).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByText("Show exact data", { selector: "summary" }));
    expect(screen.getByRole("table", { name: /separate signed residual plot/i })).not.toBeNull();
  });

  it("uses delta-only Fahrenheit conversion and retains the residual sign", () => {
    expect(temperatureDeltaForDisplay(-1, "imperial")).toBeCloseTo(-1.8);
    expect(temperatureFromDisplay(50, "imperial")).toBeCloseTo(10);
    expect(formatSignedTemperatureDelta(1, "imperial")).toBe("+1.80 °F");
    expect(formatSignedTemperatureDelta(-1, "metric")).toBe("−1.00 °C");
  });

  it("converts imperial scenario input back to Celsius and requests a seven-day calibration", () => {
    const state = createDemoState();
    const cursorTimestamp = Date.parse("2026-07-14T12:00:00.000Z");
    render(<I18nProvider><ThermalSimulationPanel
      houseId="house-main"
      sensor={state.sensors[0]!}
      range="6h"
      units="imperial"
      timeZone="Europe/Helsinki"
      currentOutdoorTemperatureC={10}
      cursorTimestamp={cursorTimestamp}
    /></I18nProvider>);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("50");
    fireEvent.click(screen.getByRole("button", { name: "Run model" }));
    const options = mocks.run.mock.calls.at(-1)?.[0];
    expect(options.scenarioOutdoorTemperatureC).toBeCloseTo(10);
    expect(Date.parse(options.to) - Date.parse(options.from)).toBe(7 * 24 * 3_600_000);
  });

  it("shows a non-failing collecting state when boundary history is insufficient", () => {
    mocks.result = result("insufficient-data");
    const state = createDemoState();
    render(<I18nProvider><ThermalSimulationPanel houseId="house-main" sensor={state.sensors[0]!} range="24h" units="metric" timeZone="Europe/Helsinki" /></I18nProvider>);
    expect(screen.getByText("More overlapping observations are needed")).not.toBeNull();
    expect(screen.queryByRole("img", { name: /separate signed residual plot/i })).toBeNull();
  });
});
