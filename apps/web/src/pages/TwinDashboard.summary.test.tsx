import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import type { ClimateState } from "../domain";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { TwinDashboard } from "./TwinDashboard";

describe("TwinDashboard metric summary", () => {
  it("compares fresh readings with sensors capable of the selected measurement", () => {
    localStorage.setItem("climate-twin-locale", "en");
    const base = createDemoState();
    const template = base.sensors.find((sensor) => sensor.enabled)!;
    const climate: Sensor = {
      ...template,
      id: "summary-climate-live",
      name: "Live climate sensor",
      measurementEntityIds: { temperature: "sensor.live_temperature" },
    };
    const staleClimate: Sensor = {
      ...template,
      id: "summary-climate-stale",
      name: "Stale climate sensor",
      measurementEntityIds: { temperature: "sensor.stale_temperature" },
    };
    const plug: Sensor = {
      id: "summary-plug",
      houseId: template.houseId,
      floorId: template.floorId,
      name: "Energy plug",
      room: template.room,
      model: "Tapo P110M",
      x: template.x,
      y: template.y,
      z: template.z,
      tpLinkDeviceId: "plug-device",
      measurementEntityIds: { power: "sensor.plug_power" },
      tags: ["energy"],
      enabled: true,
    };
    const timestamp = new Date().toISOString();
    const temperature: MeasurementSample = {
      sensorId: climate.id,
      metric: "temperature",
      value: 22,
      canonicalUnit: "°C",
      timestamp,
      source: "tp-link",
      quality: "good",
    };
    const staleTemperature: MeasurementSample = {
      ...temperature,
      sensorId: staleClimate.id,
      timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
      quality: "stale",
    };
    const power: MeasurementSample = {
      sensorId: plug.id,
      metric: "power",
      value: 840,
      canonicalUnit: "W",
      timestamp,
      source: "tp-link",
      quality: "good",
    };
    const state: ClimateState = {
      ...base,
      sensors: [climate, staleClimate, plug],
      readings: {},
      latestMeasurements: {
        [climate.id]: { temperature },
        [staleClimate.id]: { temperature: staleTemperature },
        [plug.id]: { power },
      },
      measurementHistory: {
        [climate.id]: { temperature: [temperature] },
        [staleClimate.id]: { temperature: [staleTemperature] },
        [plug.id]: { power: [power] },
      },
      alerts: [],
    };
    const house = state.houses[0]!;
    const floor = house.floors[0]!;

    render(<I18nProvider><TwinDashboard
      state={state}
      house={house}
      floor={floor}
      houseId={house.id}
      floorId={floor.id}
      metric="temperature"
      units="metric"
      viewMode="plan"
      selectedSensorId={climate.id}
      saveState="idle"
      scenario="normal"
      dataMode="demo"
      onHouse={vi.fn()}
      onFloor={vi.fn()}
      onMetric={vi.fn()}
      onViewMode={vi.fn()}
      onSensorSelect={vi.fn()}
      onSensorMove={vi.fn()}
      onSensorUpdate={vi.fn().mockResolvedValue(climate)}
      onFloorChange={vi.fn()}
      onSaveLayout={vi.fn()}
      onLoadSeries={vi.fn()}
      onRunScenario={vi.fn()}
      onCreateObservation={vi.fn().mockResolvedValue(base.observations[0]!)}
      onCreateStaticParameter={vi.fn().mockResolvedValue(base.staticParameters[0]!)}
    /></I18nProvider>);

    const summary = screen.getByLabelText("Your home, at a glance");
    expect(within(summary).getByText("Temperature sensors reporting")).not.toBeNull();
    expect(within(summary).getByText("1 of 2")).not.toBeNull();
    expect(within(summary).queryByText("1 of 3")).toBeNull();
  });
});
