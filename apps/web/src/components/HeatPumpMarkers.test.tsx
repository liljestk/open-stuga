import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HeatPumpState, MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { heatPumpSensorId, sensorRepresentsHeatPump } from "../heatPump/presentation";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { HeatPumpInspector } from "../pages/TwinDashboard/HeatPumpInspector";
import { HeatPumpMarker2D, HeatPumpMarker3D } from "./HeatPumpMarkers";

const observedAt = "2026-08-04T16:00:00.000Z";

function heatPump(overrides: Partial<HeatPumpState> = {}): HeatPumpState {
  return {
    connectionId: "gree-aabbccddeeff",
    houseId: "house-main",
    equipmentId: "heat-pump-aabbccddeeff",
    deviceId: "AABBCCDDEEFF",
    name: "AC3a95",
    brand: "Wilfa",
    model: "Nordkapp 30",
    transport: "ewpe-cloud",
    floorId: "floor-ground",
    roomId: "room-living",
    x: 4.2,
    y: 1.1,
    z: 2.05,
    observedAt,
    receivedAt: "2026-08-04T16:00:01.000Z",
    available: true,
    power: true,
    selectedMode: "dry",
    targetTemperatureC: 20,
    currentTemperatureC: 22,
    currentTemperatureSource: "reported",
    currentHumidityPercent: 58,
    targetHumidityPercent: 50,
    fanSpeed: "medium-high",
    horizontalSwing: "middle-left",
    verticalSwing: "full",
    freshAir: true,
    anion: false,
    sleep: false,
    light: true,
    quiet: true,
    turbo: false,
    xfan: true,
    steadyHeat: false,
    powerSave: true,
    cleanFilter: false,
    waterFull: false,
    dehumidifierMode: "default",
    compressorFrequencyHz: 12,
    diagnostics: { wifiStatus: 1, faultCode: 0, outdoorTemperatureRaw: 7 },
    activity: "unknown",
    activityEvidence: "unavailable",
    ...overrides,
  };
}

function homeFixture() {
  const demo = createDemoState();
  const base = demo.houses[0]!;
  const floor = {
    ...base.floors[0]!,
    id: "floor-ground",
    name: "Ground floor",
    rooms: [{ ...base.floors[0]!.rooms[0]!, id: "room-living", name: "Living room" }],
  };
  const house = { ...base, id: "house-main", floors: [floor] };
  return { demo, floor, house };
}

describe("Heat-pump map presentation", () => {
  it("uses the selected map metric and opens details without a native SVG tooltip", () => {
    const { demo, floor } = homeFixture();
    const onSelect = vi.fn();
    const definition = definitionFor(demo.measurementDefinitions, "temperature");
    const view = render(<I18nProvider><svg><HeatPumpMarker2D
      state={heatPump()} floor={floor} scale={1} definition={definition} units="metric"
      editing={false} pending={false} selected influenceVisible referenceTimeMs={Date.parse(observedAt) + 30_000}
      onSelect={onSelect}
    /></svg></I18nProvider>);

    const marker = screen.getByRole("button", { name: /AC3a95, Ground floor.*Temperature: 22/ });
    expect(marker.getAttribute("aria-pressed")).toBe("true");
    expect(marker.textContent).toContain("22");
    expect(marker.querySelector("title")).toBeNull();
    fireEvent.keyDown(marker, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("gree-aabbccddeeff", floor.id);
    expect(view.container.querySelector(".heat-pump-marker.selected")).not.toBeNull();
  });

  it("shows humidity and the same selectable state in 3D", () => {
    const { demo, floor } = homeFixture();
    const onSelect = vi.fn();
    const definition = definitionFor(demo.measurementDefinitions, "humidity");
    render(<I18nProvider><svg><HeatPumpMarker3D
      state={heatPump()} floor={floor} position={{ x: 100, y: 80 }} anchor={{ x: 100, y: 130 }}
      definition={definition} units="metric" activeFloor selected={false} influenceVisible
      referenceTimeMs={Date.parse(observedAt) + 30_000} onSelect={onSelect}
    /></svg></I18nProvider>);

    const marker = screen.getByRole("button", { name: /Humidity: 58%/ });
    expect(marker.textContent).toContain("58");
    fireEvent.click(marker);
    expect(onSelect).toHaveBeenCalledWith("gree-aabbccddeeff", floor.id);
  });

  it("recognizes the generated Gree sensor so only one marker is drawn", () => {
    const sensor = {
      ...createDemoState().sensors[0]!,
      id: heatPumpSensorId("gree-aabbccddeeff"),
      tags: ["integration:gree", "equipment:heat-pump"],
    } satisfies Sensor;
    expect(sensorRepresentsHeatPump(sensor, [heatPump()])).toBe(true);
    expect(sensorRepresentsHeatPump({ ...sensor, id: "another-sensor" }, [heatPump()])).toBe(false);
  });

  it("marks an old Wilfa reading as stale instead of presenting it as current", () => {
    const { demo, floor } = homeFixture();
    const definition = definitionFor(demo.measurementDefinitions, "temperature");
    const view = render(<I18nProvider><svg><HeatPumpMarker2D
      state={heatPump()} floor={floor} scale={1} definition={definition} units="metric"
      editing={false} pending={false} influenceVisible
      referenceTimeMs={Date.parse(observedAt) + 16 * 60_000}
    /></svg></I18nProvider>);

    expect(screen.getByRole("img", { name: /stale data.*Temperature: No data yet/ })).not.toBeNull();
    expect(view.container.querySelector(".heat-pump-marker.stale")?.textContent).toContain("—");
  });
});

describe("HeatPumpInspector", () => {
  it("groups readable live data and keeps every advanced state and raw diagnostic on demand", () => {
    const { demo, house } = homeFixture();
    const definition = definitionFor(demo.measurementDefinitions, "humidity");
    const view = render(<I18nProvider><HeatPumpInspector
      state={heatPump()} house={house} selectedDefinition={definition} units="metric"
      referenceTimeMs={Date.parse(observedAt) + 30_000}
    /></I18nProvider>);

    const inspector = screen.getByRole("complementary", { name: "AC3a95" });
    expect(within(inspector).getByText("Living room")).not.toBeNull();
    expect(within(inspector).getByText("22 °C")).not.toBeNull();
    expect(within(inspector).getByText("58%")).not.toBeNull();
    expect(within(inspector).getByText("50%")).not.toBeNull();
    expect(within(inspector).getByText("Drying")).not.toBeNull();
    expect(within(inspector).getByText("Medium high")).not.toBeNull();
    expect(within(inspector).getByText("reported compressor frequency 12 Hz")).not.toBeNull();

    const disclosure = within(inspector).getByText("Settings and diagnostics").closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(within(disclosure).getByText("Settings and diagnostics"));
    expect(disclosure.open).toBe(true);
    expect(within(disclosure).getByText("Fresh-air valve")).not.toBeNull();
    expect(within(disclosure).getByText("Filter needs cleaning")).not.toBeNull();
    expect(within(disclosure).getByText("Outdoor temperature (raw)")).not.toBeNull();
    expect(within(disclosure).getByText("AABBCCDDEEFF")).not.toBeNull();
    expect(view.container.querySelector(".heat-pump-current > .selected")?.textContent).toContain("Indoor humidity");
  });

  it("brings the selected advanced measurement into the sensor card group", () => {
    const { demo, house } = homeFixture();
    const definition = {
      ...definitionFor(demo.measurementDefinitions, "temperature"),
      id: "heat_pump_compressor_frequency",
      labels: { en: "Compressor frequency", fi: "Kompressorin taajuus", sv: "Kompressorfrekvens" },
      unit: "Hz",
      allowedUnits: ["Hz"],
      dimension: "frequency",
    } satisfies MeasurementDefinition;
    const view = render(<I18nProvider><HeatPumpInspector
      state={heatPump()} house={house} selectedDefinition={definition} units="metric"
      referenceTimeMs={Date.parse(observedAt) + 30_000}
    /></I18nProvider>);

    const selected = view.container.querySelector(".heat-pump-current > .selected");
    expect(selected?.textContent).toContain("Compressor frequency");
    expect(selected?.textContent).toContain("12 Hz");
  });

  it.each([
    ["heat_pump_sleep_mode_raw", "Sleep mode (raw)", "sleepModeRaw", 1],
    ["heat_pump_temperature_unit_raw", "Temperature unit (raw)", "temperatureUnitRaw", 0],
    ["heat_pump_temperature_record_raw", "Temperature encoding (raw)", "temperatureRecordRaw", 2],
    ["heat_pump_heat_cool_type_raw", "Heat/cool type (raw)", "heatCoolTypeRaw", 3],
  ] as const)("shows selected diagnostic metric %s in the primary group", (id, label, field, value) => {
    const { demo, house } = homeFixture();
    const definition = {
      ...definitionFor(demo.measurementDefinitions, "temperature"),
      id,
      labels: { en: label, fi: label, sv: label },
      unit: "raw",
      allowedUnits: ["raw"],
      dimension: "diagnostic",
    } satisfies MeasurementDefinition;
    const view = render(<I18nProvider><HeatPumpInspector
      state={heatPump({ diagnostics: { [field]: value } })} house={house}
      selectedDefinition={definition} units="metric"
      referenceTimeMs={Date.parse(observedAt) + 30_000}
    /></I18nProvider>);

    const selected = view.container.querySelector(".heat-pump-current > .selected");
    expect(selected?.textContent).toContain(label);
    expect(selected?.textContent).toContain(String(value));
  });
});
