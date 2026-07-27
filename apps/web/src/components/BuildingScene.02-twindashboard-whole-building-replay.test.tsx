import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import { describe, expect, it, vi } from "vitest";

import type { ConfiguredOpeningState, Floor, ManualObservation, MeasurementDefinition, MeasurementSample, OpeningStateObservation, Sensor, UnitSystem } from "@climate-twin/contracts";

import { createDemoState } from "../domain";

import { I18nProvider } from "../i18n";

import { definitionFor } from "../measurements";

import { TwinDashboard } from "../pages/TwinDashboard";

import { api } from "../api";

import { BuildingScene } from "./BuildingScene";

import { renderScene } from "./BuildingSceneTestSupport";

describe("TwinDashboard whole-building replay", () => {
  it("persists a live map toggle as runtime state instead of a layout edit", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const baseFloor = demo.houses[0]!.floors[0]!;
    const floor: Floor = {
      ...baseFloor,
      planElements: [{
        id: "runtime-door", kind: "door", wallId: baseFloor.walls[0]!.id,
        position: { x: 220, y: 45 }, rotationDegrees: 0, state: "closed",
      }],
    };
    const house = { ...demo.houses[0]!, floors: [floor] };
    const state = { ...demo, houses: [house] };
    const openingStates = vi.spyOn(api, "openingStates").mockResolvedValue({
      snapshot: { houseId: house.id, at: "2026-07-21T08:00:00.000Z", states: [] }, observations: [],
    });
    const recordOpeningState = vi.spyOn(api, "recordOpeningState").mockImplementation(async (houseId, input) => ({
      ...input, id: "manual-runtime-toggle", houseId, observedAt: "2026-07-21T08:00:30.000Z",
    }));
    const onFloorChange = vi.fn();
    try {
      render(
        <I18nProvider>
          <TwinDashboard
            state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
            metric="temperature" units="metric" viewMode="plan" selectedSensorId={demo.sensors[0]!.id}
            saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
            onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={vi.fn()}
            onFloorChange={onFloorChange} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
            onCreateObservation={vi.fn().mockResolvedValue(demo.observations[0]!)}
            onCreateStaticParameter={vi.fn().mockResolvedValue(demo.staticParameters[0]!)}
          />
        </I18nProvider>,
      );

      await waitFor(() => expect(openingStates).toHaveBeenCalledWith(house.id, undefined, expect.any(AbortSignal)));
      await user.click(screen.getByRole("button", { name: "Open live home view" }));
      expect(await screen.findByText(/Select a door, window, or vent/i)).not.toBeNull();
      await user.click(await screen.findByRole(
        "button",
        { name: /Door 1, Closed.*Open/i },
        { timeout: 5_000 },
      ));
      await waitFor(() => expect(recordOpeningState).toHaveBeenCalledOnce());
      expect(recordOpeningState).toHaveBeenCalledWith(house.id, expect.objectContaining({
        floorId: floor.id, elementId: "runtime-door", state: "open", source: "manual",
      }));
      expect(recordOpeningState.mock.calls[0]?.[1]).not.toHaveProperty("observedAt");
      await waitFor(() => expect(screen.getByRole("button", { name: /Door 1, Open.*Closed/i }).getAttribute("data-opening-state")).toBe("open"));
      expect(onFloorChange).not.toHaveBeenCalled();
      expect(screen.getByText("Door 1 is now Open.", { selector: ".sr-only" })).not.toBeNull();
    } finally {
      openingStates.mockRestore();
      recordOpeningState.mockRestore();
    }
  });

  it("suppresses derived summaries when there are no usable readings", () => {
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const state = { ...demo, latestMeasurements: {}, measurementHistory: {} };
    const onOpenSensors = vi.fn();
    const onOpenConnections = vi.fn();
    const view = render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
          metric="temperature" units="metric" viewMode="isometric" selectedSensorId={demo.sensors[0]!.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={vi.fn()}
          onFloorChange={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(demo.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(demo.staticParameters[0]!)}
          onOpenSensors={onOpenSensors}
          onOpenConnections={onOpenConnections}
        />
      </I18nProvider>,
    );

    expect(view.container.querySelector(".home-status-zone")).toBeNull();
    expect(view.container.querySelector(".moisture-coach")).toBeNull();
    expect(view.container.querySelector(".room-comfort-section")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(onOpenConnections).toHaveBeenCalledWith(house.id);
    expect(onOpenSensors).not.toHaveBeenCalled();
  });

  it("loads every airflow driver for every enabled house sensor in isometric replay", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const disabled = { ...demo.sensors.at(-1)!, enabled: false };
    const otherHouse: Sensor = {
      ...demo.sensors[0]!, id: "sensor-other-house", houseId: "house-other", name: "Other house sensor",
    };
    const state = { ...demo, sensors: [...demo.sensors.slice(0, -1), disabled, otherHouse] };
    const enabledHouseSensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
    const selectedSensor = enabledHouseSensors[0]!;
    const onLoadSeries = vi.fn();
    render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
          metric="temperature" units="metric" viewMode="isometric" selectedSensorId={selectedSensor.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
          onSensorUpdate={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={onLoadSeries} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Open history and replay" }));
    await user.click(screen.getByRole("button", { name: "Play replay" }));
    await waitFor(() => expect(onLoadSeries).toHaveBeenCalledTimes(enabledHouseSensors.length * 3));
    for (const metric of ["temperature", "humidity", "co2"]) {
      expect(onLoadSeries.mock.calls.filter(([, loadedMetric]) => loadedMetric === metric).map(([sensorId]) => sensorId).sort())
        .toEqual(enabledHouseSensors.map((sensor) => sensor.id).sort());
    }
    expect(onLoadSeries.mock.calls.filter(([sensorId]) => sensorId === selectedSensor.id)).toHaveLength(3);
    expect(onLoadSeries.mock.calls.every(([, , range, forecastSupported]) => range === "24h" && forecastSupported === true)).toBe(true);
  });

  it("clamps an active replay when asynchronously loaded history changes its bounds", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const house = demo.houses[0]!;
    const floor = house.floors[0]!;
    const selectedSensor = demo.sensors[0]!;
    const stateWithoutHistory = { ...demo, measurementHistory: {} };
    const commonProps = {
      house, floor, houseId: house.id, floorId: floor.id, metric: "temperature" as const,
      units: "metric" as const, viewMode: "isometric" as const, selectedSensorId: selectedSensor.id,
      saveState: "idle" as const, scenario: "normal" as const, onHouse: vi.fn(), onFloor: vi.fn(),
      onMetric: vi.fn(), onViewMode: vi.fn(), onSensorSelect: vi.fn(), onSensorMove: vi.fn(),
      onSensorUpdate: vi.fn(), onFloorChange: vi.fn(), onSaveLayout: vi.fn(), onLoadSeries: vi.fn(),
      onRunScenario: vi.fn(), onCreateObservation: vi.fn().mockResolvedValue(demo.observations[0]!),
      onCreateStaticParameter: vi.fn().mockResolvedValue(demo.staticParameters[0]!),
    };
    const view = render(<I18nProvider><TwinDashboard state={stateWithoutHistory} {...commonProps} /></I18nProvider>);
    await user.click(screen.getByRole("button", { name: "Open history and replay" }));
    await user.click(screen.getByRole("button", { name: "Play replay" }));

    const oldSample = {
      ...demo.latestMeasurements[selectedSensor.id]!.temperature!,
      timestamp: "2020-01-01T10:00:00.000Z",
    };
    const loadedState = {
      ...stateWithoutHistory,
      measurementHistory: { [selectedSensor.id]: { temperature: [oldSample] } },
    };
    view.rerender(<I18nProvider><TwinDashboard state={loadedState} {...commonProps} /></I18nProvider>);

    const slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
    await waitFor(() => expect(Number(slider.value)).toBeLessThanOrEqual(Number(slider.max)));
    expect(Number(slider.value)).toBeGreaterThanOrEqual(Number(slider.min));
  });

  it("applies an edit-only floor and relative mounting-height placement", async () => {
    const user = userEvent.setup();
    const demo = createDemoState();
    const originalHouse = demo.houses[0]!;
    const ground = originalHouse.floors[0]!;
    const targetFloor: Floor = { ...originalHouse.floors[1]!, width: 100, height: 80, elevation: 3 };
    const house = { ...originalHouse, floors: [ground, targetFloor] };
    const state = { ...demo, houses: [house] };
    const selectedSensor = state.sensors.find((sensor) => sensor.floorId === ground.id)!;
    const onSensorUpdate = vi.fn();
    const onFloor = vi.fn();
    render(
      <I18nProvider>
        <TwinDashboard
          state={state} house={house} floor={ground} houseId={house.id} floorId={ground.id}
          metric="temperature" units="metric" viewMode="plan" selectedSensorId={selectedSensor.id}
          saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={onFloor} onMetric={vi.fn()}
          onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onSensorUpdate={onSensorUpdate}
          onFloorChange={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
          onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
          onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
        />
      </I18nProvider>,
    );

    expect(screen.queryByLabelText("Sensor floor")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open live home view" }));
    await user.click(await screen.findByRole("button", { name: "Edit layout" }));
    expect(screen.queryByRole("combobox", { name: "Metric" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Replay" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Room thermal model" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Available measurements" })).toBeNull();
    expect(await screen.findByText(/Drag this sensor on the plan.*arrow keys/i)).not.toBeNull();
    await user.selectOptions(screen.getByLabelText("Sensor floor"), targetFloor.id);
    const mountingHeight = screen.getByLabelText(/^Mounting height/) as HTMLInputElement;
    await user.clear(mountingHeight);
    await user.type(mountingHeight, "2.2");
    await user.click(screen.getByRole("button", { name: "Apply placement" }));

    expect(onSensorUpdate).toHaveBeenCalledOnce();
    const [sensorId, patch] = onSensorUpdate.mock.calls[0]!;
    expect(sensorId).toBe(selectedSensor.id);
    expect(patch).toMatchObject({ floorId: targetFloor.id, x: targetFloor.width, y: targetFloor.height });
    expect(patch.z).toBeCloseTo(targetFloor.elevation + 2.2, 5);
    expect(onFloor).toHaveBeenCalledWith(targetFloor.id);
  });
});
