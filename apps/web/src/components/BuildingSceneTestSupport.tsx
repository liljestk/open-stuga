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

export function renderScene(options: {
  floors?: Floor[];
  sensors?: Sensor[];
  samples?: Record<string, MeasurementSample>;
  observations?: ManualObservation[];
  definition?: MeasurementDefinition;
  units?: UnitSystem;
  editing?: boolean;
  sensorMeasurements?: Record<string, Record<string, MeasurementSample>>;
  energyDevicesVisible?: boolean;
  referenceTimeMs?: number;
  openingStateObservations?: OpeningStateObservation[];
  pendingOpeningStateKeys?: ReadonlySet<string>;
  onOpeningStateChange?: (floorId: string, elementId: string, state: ConfiguredOpeningState) => void;
} = {}) {
  const state = createDemoState();
  const house = { ...state.houses[0]!, floors: options.floors ?? state.houses[0]!.floors };
  const sensors = options.sensors ?? state.sensors.filter((sensor) => sensor.houseId === house.id);
  const definition = options.definition ?? definitionFor(state.measurementDefinitions, "temperature");
  const samples = options.samples ?? Object.fromEntries(sensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  }));
  const onFloorSelect = vi.fn();
  const onSensorSelect = vi.fn();
  const onFloorChange = vi.fn();
  const onOpeningStateChange = options.onOpeningStateChange ?? vi.fn();
  const view = render(
    <I18nProvider>
      <BuildingScene
        house={house} sensors={sensors} samples={samples}
        {...(options.sensorMeasurements ? { sensorMeasurements: options.sensorMeasurements } : {})}
        {...(options.energyDevicesVisible === undefined ? {} : { energyDevicesVisible: options.energyDevicesVisible })}
        observations={options.observations ?? state.observations} definition={definition} units={options.units ?? "metric"}
        activeFloorId={house.floors[0]!.id} selectedSensorId={sensors.find((sensor) => sensor.enabled)?.id ?? null}
        {...(options.referenceTimeMs === undefined ? {} : { referenceTimeMs: options.referenceTimeMs })}
        openingStateObservations={options.openingStateObservations ?? []}
        pendingOpeningStateKeys={options.pendingOpeningStateKeys ?? new Set()}
        onOpeningStateChange={onOpeningStateChange}
        editing={options.editing ?? false}
        onFloorSelect={onFloorSelect} onSensorSelect={onSensorSelect} onFloorChange={onFloorChange}
      />
    </I18nProvider>,
  );
  return { ...view, state, house, sensors, samples, definition, onFloorSelect, onSensorSelect, onFloorChange, onOpeningStateChange };
}
